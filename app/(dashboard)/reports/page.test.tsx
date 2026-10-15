import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"

// Every Prisma call is recorded; reads answer empty unless `answer` says otherwise.
const { calls, state } = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; args: Record<string, unknown> }>,
  state: { answer: (() => undefined) as (op: string, args: Record<string, unknown>) => unknown },
}))
const empty: Record<string, unknown> = { aggregate: { _count: 0, _sum: {} }, findMany: [], groupBy: [], count: 0 }
const model = (name: string) => new Proxy({}, {
  get: (_, method: string) => async (args: Record<string, unknown>) => {
    const op = `${name}.${method}`
    calls.push({ op, args })
    return state.answer(op, args) ?? empty[method]
  },
})

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: (_, name: string) => model(name) }),
}))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: vi.fn(async () => ({ id: "u1" })) }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/reports/charges-owing", () => ({
  loadChargesOwingByBand: vi.fn(async () => ({ chargesLive: false, byBand: {}, notInArrears: { count: 0, amount: 0 }, total: 0 })),
}))
const { bookAsOf } = vi.hoisted(() => ({ bookAsOf: vi.fn() }))
vi.mock("@/lib/reports/book-as-of", () => ({ loadBookAsOf: (...a: unknown[]) => bookAsOf(...a) }))

import ReportsPage from "./page"

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("Reports overview", () => {
  beforeEach(() => {
    calls.length = 0
    state.answer = () => undefined
    bookAsOf.mockResolvedValue(0)
    // 10 Feb 2027 SAST: this month starts 1 Feb, the last completed quarter is Q4 2026.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2027-02-10T10:00:00Z"))
  })
  afterEach(() => vi.useRealTimers())

  it("compares the collectible book with the same book rebuilt at the start of the month", async () => {
    // Only the whole-collectible-book aggregate: no DPD filter.
    state.answer = (op, args) => {
      const where = args.where as { status?: unknown; daysInArrears?: unknown }
      return op === "loan.aggregate" && where.daysInArrears === undefined
        && JSON.stringify(where.status) === JSON.stringify({ in: [...COLLECTIBLE_STATUSES] })
        ? { _count: 3, _sum: { outstandingPrincipal: 150_000 } }
        : undefined
    }
    bookAsOf.mockResolvedValue(100_000)
    const html = text(renderToStaticMarkup(await ReportsPage()))
    expect(bookAsOf).toHaveBeenCalledWith(expect.anything(), "tenant-1", new Date("2027-01-31T22:00:00Z"))
    expect(html).toContain("COLLECTIBLE BOOK (FEBRUARY) R2k Active, defaulted, pending write-off and restructured loans 50% vs start of month")
  })

  it("leaves a reversed loan's CANCELLED instalments out of the collection-rate denominator", async () => {
    await ReportsPage()
    const expected = calls.find((c) => c.op === "repaymentSchedule.aggregate")
    expect((expected?.args.where as { status?: unknown }).status).toEqual({ not: "CANCELLED" })
  })

  it("puts only collectible accounts in the collections stage funnel", async () => {
    await ReportsPage()
    const funnel = calls.find((c) => c.op === "loan.groupBy" && (c.args.by as string[]).includes("collectionsStage"))
    expect(funnel?.args.where).toEqual({ tenantId: "tenant-1", status: { in: [...COLLECTIBLE_STATUSES] } })
  })

  it("labels the NCR links with the quarter they open on, not a fixed one", async () => {
    const html = text(renderToStaticMarkup(await ReportsPage()))
    expect(html).toContain("Quarterly NCR Return Q4 2026")
    expect(html).toContain("NCR Quarterly Export (Excel) Q4 2026")
    expect(html).toContain("Arrears Aging Report As at today")
    expect(html).not.toContain("Q1 2026")
  })

  it("calls the share of accounts with no arrears what it is, with no fixed verdict", async () => {
    const html = text(renderToStaticMarkup(await ReportsPage()))
    expect(html).toContain("ACCOUNTS UP TO DATE")
    expect(html).not.toContain("On target")
  })
})
