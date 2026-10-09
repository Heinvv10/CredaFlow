import { describe, it, expect, vi, beforeEach } from "vitest"

// Named mocks, re-armed in beforeEach: vi.resetAllMocks() wipes an
// implementation set inside the factory (it runs once, at import time), so an
// inline mockResolvedValue would silently become undefined after the first reset.
const referralEventFindManyMock = vi.fn()
const loanFindManyMock = vi.fn()
const agentFindManyMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    referralEvent: { findMany: (...a: unknown[]) => referralEventFindManyMock(...a) },
    loan: { findMany: (...a: unknown[]) => loanFindManyMock(...a) },
    referralAgent: { findMany: (...a: unknown[]) => agentFindManyMock(...a) },
  },
}))

import { loadStatementData } from "./load-statement-data"

const FROM = new Date("2026-08-01T00:00:00.000Z")
const TO = new Date("2026-09-01T00:00:00.000Z")

function eventFor(id: string, agentId: string | null, cents: number, status = "PENDING") {
  return {
    id,
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
    agentId,
    amountCents: 100000,
    commissionCents: cents,
    commissionStatus: status,
    metadata: {},
  }
}

describe("loadStatementData", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    referralEventFindManyMock.mockResolvedValue([])
    loanFindManyMock.mockResolvedValue([])
    agentFindManyMock.mockResolvedValue([])
  })

  // The load-bearing invariant. If this short-circuit is removed, the query
  // below runs with NO agentId filter — i.e. every agent in the tenant — for a
  // page load where nobody selected anyone.
  it("queries NOTHING when no agent is selected", async () => {
    const result = await loadStatementData("t1", { kind: "none" }, FROM, TO)
    expect(referralEventFindManyMock).not.toHaveBeenCalled()
    expect(loanFindManyMock).not.toHaveBeenCalled()
    expect(agentFindManyMock).not.toHaveBeenCalled()
    expect(result.groups).toEqual([])
    expect(result.totals.netOwedCents).toBe(0)
  })

  it("scopes the query to the chosen agents for a selection", async () => {
    await loadStatementData("t1", { kind: "some", agentIds: ["a1", "a2"] }, FROM, TO)
    const where = referralEventFindManyMock.mock.calls[0][0].where
    expect(where.agentId).toEqual({ in: ["a1", "a2"] })
    expect(where.tenantId).toBe("t1")
    expect(where.eventType).toBe("CONVERTED")
  })

  it("omits the agentId filter entirely for all-agents", async () => {
    // Deliberately absent rather than `in: <roster>`, so an agent created after
    // the roster query still appears in the statement.
    await loadStatementData("t1", { kind: "all" }, FROM, TO)
    const where = referralEventFindManyMock.mock.calls[0][0].where
    expect(where).not.toHaveProperty("agentId")
    expect(where.tenantId).toBe("t1")
  })

  it("bounds the query to the requested period", async () => {
    await loadStatementData("t1", { kind: "all" }, FROM, TO)
    const where = referralEventFindManyMock.mock.calls[0][0].where
    // `lt`, never `lte` — parsePeriod's upper bound is exclusive.
    expect(where.createdAt).toEqual({ gte: FROM, lt: TO })
  })

  it("groups rows by agent, names them, and subtotals each", async () => {
    agentFindManyMock.mockResolvedValue([
      { id: "a1", displayName: "Test Agent One" },
      { id: "a2", displayName: "Amos Mockery" },
    ])
    referralEventFindManyMock.mockResolvedValue([
      eventFor("e1", "a1", 5000),
      eventFor("e2", "a1", 3000),
      eventFor("e3", "a2", 1000),
    ])

    const result = await loadStatementData("t1", { kind: "all" }, FROM, TO)
    expect(result.groups.map((g) => [g.agentName, g.totals.netOwedCents])).toEqual([
      ["Amos Mockery", 1000],
      ["Test Agent One", 8000],
    ])
    // Grand total must reconcile with the subtotals beside it.
    expect(result.totals.netOwedCents).toBe(9000)
  })

  it("scopes the loan lookup to the tenant", async () => {
    // Borrower names come from Loan; an unscoped lookup would surface another
    // tenant's client on a statement row.
    agentFindManyMock.mockResolvedValue([{ id: "a1", displayName: "A" }])
    referralEventFindManyMock.mockResolvedValue([
      { ...eventFor("e1", "a1", 5000), metadata: { loanId: "L1" } },
    ])
    await loadStatementData("t1", { kind: "all" }, FROM, TO)
    expect(loanFindManyMock.mock.calls[0][0].where.tenantId).toBe("t1")
  })

  it("scopes the agent roster to the tenant", async () => {
    await loadStatementData("t1", { kind: "all" }, FROM, TO)
    expect(agentFindManyMock.mock.calls[0][0].where.tenantId).toBe("t1")
  })

  it("keeps an event whose agent no longer resolves, rather than dropping it", async () => {
    // Dropping it would make the subtotals stop reconciling with the footer.
    agentFindManyMock.mockResolvedValue([])
    referralEventFindManyMock.mockResolvedValue([eventFor("e1", "gone", 2500)])
    const result = await loadStatementData("t1", { kind: "all" }, FROM, TO)
    expect(result.groups).toHaveLength(1)
    expect(result.totals.netOwedCents).toBe(2500)
  })
})
