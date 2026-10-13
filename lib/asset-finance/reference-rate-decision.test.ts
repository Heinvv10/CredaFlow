import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { decideReferenceRate, type DecisionDb } from "./reference-rate-decision"

const m = vi.hoisted(() => ({ logAuditStrict: vi.fn() }))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))

const PENDING = {
  id: "rr1", tenantId: "t1", basis: "PRIME" as const, effectiveDate: new Date("2027-01-15T00:00:00Z"), rate: new Prisma.Decimal("0.12"),
  status: "PENDING" as const, requestedById: "u1", decidedById: null, decidedAt: null, createdAt: new Date("2027-01-10T08:00:00Z"),
}

function fakeDb(state: { pending?: typeof PENDING | null; wouldReprice?: number; alreadyLater?: number; later?: boolean }) {
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...PENDING, ...data }))
  const createMany = vi.fn(async () => ({ count: 1 }))
  const count = vi.fn(async ({ where }: { where: { AND?: unknown } }) => (where.AND ? state.alreadyLater ?? 0 : state.wouldReprice ?? 0))
  const db = {
    $queryRaw: vi.fn(async () => (state.pending === null ? [] : [{ id: "rr1" }])),
    referenceRate: {
      findFirst: vi.fn(async ({ where }: { where: { status?: string } }) =>
        where.status === "APPROVED" ? (state.later ? { id: "rr-later" } : null) : state.pending ?? PENDING),
      update,
    },
    loan: { count },
    user: { findMany: vi.fn(async () => [{ id: "admin1" }, { id: "admin2" }]) },
    notification: { createMany },
    auditLog: { create: vi.fn() },
  }
  return { db: db as unknown as DecisionDb, update, createMany, count }
}

const decide = (db: DecisionDb, decision: "APPROVE" | "REJECT", deciderId = "u2", today = "2027-01-15") =>
  decideReferenceRate(db, { tenantId: "t1", rateId: "rr1", decision, deciderId, today })

describe("decideReferenceRate", () => {
  beforeEach(() => m.logAuditStrict.mockReset())

  it("refuses the requester (four-eyes) and changes nothing", async () => {
    const fake = fakeDb({})
    expect(await decide(fake.db, "APPROVE", "u1")).toEqual({ kind: "self_decision" })
    expect(fake.update).not.toHaveBeenCalled()
    expect(m.logAuditStrict).not.toHaveBeenCalled()
  })

  it("refuses a decided or missing rate", async () => {
    expect(await decide(fakeDb({ pending: { ...PENDING, status: "APPROVED" as "PENDING" } }).db, "REJECT")).toEqual({ kind: "not_pending", status: "APPROVED" })
    expect(await decide(fakeDb({ pending: null }).db, "REJECT")).toEqual({ kind: "not_found" })
  })

  it("approves as the decider and audits it; an approval that reaches loans raises no alert", async () => {
    const fake = fakeDb({ wouldReprice: 3 })
    const outcome = await decide(fake.db, "APPROVE")
    expect(fake.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "rr1", tenantId: "t1" }, data: expect.objectContaining({ status: "APPROVED", decidedById: "u2" }),
    }))
    expect(outcome).toMatchObject({ kind: "decided", reach: { wouldReprice: 3, alerted: false } })
    expect(fake.createMany).not.toHaveBeenCalled()
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "REFERENCE_RATE_DECIDED", entityId: "rr1", userId: "u2" }), fake.db)
  })

  it("a backdated approval that still reprices loans raises no alert", async () => {
    const fake = fakeDb({ wouldReprice: 2, alreadyLater: 1 })
    expect(await decide(fake.db, "APPROVE", "u2", "2027-02-01")).toMatchObject({ reach: { wouldReprice: 2, backdated: true, alerted: false } })
    expect(fake.createMany).not.toHaveBeenCalled()
  })

  it("a REJECT checks no reach and raises no alert", async () => {
    const fake = fakeDb({})
    expect(await decide(fake.db, "REJECT")).toMatchObject({ kind: "decided", reach: null })
    expect(fake.count).not.toHaveBeenCalled()
    expect(fake.createMany).not.toHaveBeenCalled()
  })

  it.each([
    ["backdated", { alreadyLater: 2 }, "2027-02-01"],
    ["superseded", { later: true }, "2027-01-15"],
  ] as const)("a %s approval that reprices nothing alerts every loan admin", async (_label, state, today) => {
    const fake = fakeDb({ wouldReprice: 0, ...state })
    const outcome = await decide(fake.db, "APPROVE", "u2", today)
    expect(outcome).toMatchObject({ kind: "decided", reach: { wouldReprice: 0, alerted: true } })
    const [{ data }] = fake.createMany.mock.calls[0] as unknown as [{ data: Array<Record<string, string>> }]
    expect(data.map((n) => [n.userId, n.type, n.entityType, n.entityId])).toEqual([
      ["admin1", "REFERENCE_RATE_NO_EFFECT", "ReferenceRate", "rr1"],
      ["admin2", "REFERENCE_RATE_NO_EFFECT", "ReferenceRate", "rr1"],
    ])
    expect(data[0].title).toBe("Approved PRIME 12% from 2027-01-15 reprices no loan")
  })

  it("an approval effective today that reprices nothing is not superseded or backdated: no alert", async () => {
    const fake = fakeDb({ wouldReprice: 0 })
    expect(await decide(fake.db, "APPROVE", "u2", "2027-01-15")).toMatchObject({ reach: { alerted: false, backdated: false, superseded: false } })
    expect(fake.createMany).not.toHaveBeenCalled()
  })
})
