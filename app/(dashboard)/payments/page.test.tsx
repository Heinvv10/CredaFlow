import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

/**
 * What matters on this page is not what it looks like but WHICH WINDOW each
 * query asks for. Three separate rules have to hold at once and they disagree
 * with each other on purpose:
 *
 *  - the allocated list and the period card follow the selected period,
 *  - the all-time card ignores it entirely,
 *  - the unapplied list is never date-bounded at all, because unapplied money
 *    is a live liability and a filter that could hide one loses money.
 *
 * So these assertions read the `where` clauses the page hands Prisma. A test
 * that only checked the rendered numbers would pass against a page that scoped
 * every query identically, which is the bug this design exists to prevent.
 */

const calls = vi.hoisted(() => ({
  findMany: [] as Array<Record<string, unknown>>,
  aggregate: [] as Array<Record<string, unknown>>,
  count: [] as Array<Record<string, unknown>>,
  clientProps: null as Record<string, unknown> | null,
  notified: [] as Array<Record<string, unknown>>,
  notifiedProps: null as Record<string, unknown> | null,
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        calls.findMany.push(args)
        return []
      }),
      count: vi.fn(async (args: Record<string, unknown>) => {
        calls.count.push(args)
        return 0
      }),
      aggregate: vi.fn(async (args: Record<string, unknown>) => {
        calls.aggregate.push(args)
        return { _sum: { amount: 123400 }, _count: 2 }
      }),
    },
    repaymentSchedule: { findMany: vi.fn(async () => []) },
    paymentNotification: { findMany: vi.fn(async () => calls.notified) },
  },
}))

vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: async () => "tenant-1" }))
vi.mock("@/components/layout/Header", () => ({ Header: () => null }))
vi.mock("@/components/payments/PaymentsClient", () => ({
  PaymentsClient: (props: Record<string, unknown>) => {
    calls.clientProps = props
    return null
  },
}))

vi.mock("@/components/payments/ClientNotifiedPayments", () => ({
  ClientNotifiedPayments: (props: Record<string, unknown>) => {
    calls.notifiedProps = props
    return null
  },
}))

import PaymentsPage from "./page"

async function render(params: Record<string, string> = {}) {
  calls.findMany = []
  calls.aggregate = []
  calls.count = []
  calls.clientProps = null
  return renderToStaticMarkup(await PaymentsPage({ searchParams: Promise.resolve(params) }))
}

/** The `where` of the one query matching every predicate. */
function whereOf(
  list: Array<Record<string, unknown>>,
  match: (where: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const hit = list.map((c) => c.where as Record<string, unknown>).filter(match)
  expect(hit.length).toBe(1)
  return hit[0]
}

const allocatedish = (w: Record<string, unknown>) =>
  w.allocationStatus === "ALLOCATED" && w.reversed === false

describe("payments page — period scoping", () => {
  beforeEach(() => vi.clearAllMocks())

  it("bounds the allocated list by the selected period", async () => {
    await render({ period: "last-month" })
    const where = whereOf(calls.findMany, allocatedish)
    expect(where.receivedAt).toBeDefined()
    const bound = where.receivedAt as { gte: Date; lt: Date }
    expect(bound.gte).toBeInstanceOf(Date)
    expect(bound.lt).toBeInstanceOf(Date)
    expect(bound.gte.getTime()).toBeLessThan(bound.lt.getTime())
  })

  it("never date-bounds the unapplied list, whatever the period", async () => {
    for (const period of ["today", "this-week", "this-month", "last-month", "all"]) {
      await render({ period })
      const where = whereOf(
        calls.findMany,
        (w) => w.allocationStatus === "UNAPPLIED" && w.reversed === false,
      )
      expect(where.receivedAt, `unapplied was scoped under period=${period}`).toBeUndefined()
    }
  })

  it("leaves the all-time aggregate unbounded while the period aggregate is bounded", async () => {
    await render({ period: "today" })
    const allocatedAggs = calls.aggregate
      .map((c) => c.where as Record<string, unknown>)
      .filter(allocatedish)
    // Exactly two: the selected period, and all time.
    expect(allocatedAggs.length).toBe(2)
    expect(allocatedAggs.filter((w) => w.receivedAt === undefined).length).toBe(1)
    expect(allocatedAggs.filter((w) => w.receivedAt !== undefined).length).toBe(1)
  })

  it("drops the date bound everywhere when the period is all time", async () => {
    await render({ period: "all" })
    for (const where of calls.findMany.map((c) => c.where as Record<string, unknown>)) {
      expect(where.receivedAt).toBeUndefined()
    }
  })

  it("uses lt, never lte, for a closed period", async () => {
    await render({ period: "custom", from: "2026-07-01", to: "2026-07-31" })
    const where = whereOf(calls.findMany, allocatedish)
    expect(Object.keys(where.receivedAt as object)).toEqual(["gte", "lt"])
  })

  it("falls back to this month for a junk period rather than erroring", async () => {
    await render({ period: "banana" })
    expect(calls.clientProps?.periodLabel).toMatch(/^[A-Z][a-z]+ \d{4}$/)
  })

  it("tells the client how many rows exist, not just how many it fetched", async () => {
    await render({ period: "this-month" })
    expect(calls.clientProps).toHaveProperty("allocatedCount")
    expect(whereOf(calls.count, allocatedish).receivedAt).toBeDefined()
  })

  it("counts BOTH capped tabs, so neither can present a cap as completeness", async () => {
    await render({ period: "this-month" })
    // Allocated and Refunded/Reversed are both `take: ROW_CAP`. A capped list
    // whose badge shows the fetched length silently reads "200" forever.
    expect(calls.count.length).toBe(2)
    expect(calls.clientProps?.allocatedCount).toBeDefined()
    expect(calls.clientProps?.resolvedCount).toBeDefined()
    const resolvedWhere = whereOf(calls.count, (w) => Array.isArray(w.OR))
    expect(resolvedWhere.receivedAt).toBeDefined()
  })

  it("hands the client a period query the export link can reuse", async () => {
    await render({ period: "custom", from: "2026-07-01", to: "2026-07-31" })
    expect(calls.clientProps?.periodQuery).toBe("period=custom&from=2026-07-01&to=2026-07-31")
  })
})

describe("payments page — client-notified payments (Fair Score audit B7)", () => {
  const report = {
    id: "pn1", amount: 84_330, reference: "EFT SEP", paymentDate: new Date("2026-10-14T22:00:00Z"), notes: null,
    documentId: "d1", createdAt: new Date("2026-10-15T08:00:00Z"),
    loan: { id: "l1", reference: "LN-0005" }, client: { firstName: "Elize", lastName: "Synthetic" },
  }

  it("lists a portal payment report awaiting reconciliation and points the KPI card at it", async () => {
    calls.notified = [report]
    const html = await render({ period: "today" })
    calls.notified = []
    expect(calls.notifiedProps).toEqual({ items: [expect.objectContaining({ id: "pn1", amount: 84_330 })] })
    expect(html).toContain("+ 1 client-notified payment to confirm")
  })

  it("says nothing extra when no report is waiting", async () => {
    const html = await render({ period: "today" })
    expect(html).not.toContain("client-notified payment")
    expect(calls.notifiedProps).toEqual({ items: [] })
  })
})
