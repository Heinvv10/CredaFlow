import { describe, it, expect } from "vitest"
import { summariseCommission, summariseByAgent } from "./summary"

const ev = (commissionStatus: string, commissionCents: number | null, agentId = "a1", agentName = "Agent One") =>
  ({ commissionStatus, commissionCents, agentId, agentName })

describe("summariseCommission", () => {
  it("totals each status in cents", () => {
    expect(summariseCommission([
      ev("PENDING", 23_000), ev("PENDING", 4_000), ev("PAYABLE", 1_000), ev("REVERSED", 500),
    ])).toEqual({
      pendingCents: 27_000, payableCents: 1_000, paidCents: 0, reversedCents: 500, netOwedCents: 28_000,
    })
  })

  // netOwed is what the lender still has to hand over: pending + payable.
  // Paid is gone, reversed was never owed.
  it("excludes paid and reversed from net owed", () => {
    expect(summariseCommission([ev("PAID", 10_000), ev("REVERSED", 5_000)]).netOwedCents).toBe(0)
  })

  it("treats a null commission as zero, not NaN", () => {
    expect(summariseCommission([ev("PENDING", null)]).pendingCents).toBe(0)
  })

  it("ignores statuses that carry no money", () => {
    expect(summariseCommission([ev("NOT_ELIGIBLE", 999), ev("BLOCKED", 999)])).toEqual({
      pendingCents: 0, payableCents: 0, paidCents: 0, reversedCents: 0, netOwedCents: 0,
    })
  })

  it("returns zeros for an empty book rather than throwing", () => {
    expect(summariseCommission([]).netOwedCents).toBe(0)
  })
})

describe("summariseByAgent", () => {
  it("groups by agent and counts loans", () => {
    const rows = summariseByAgent([
      ev("PENDING", 23_000, "a1", "Agent One"),
      ev("PENDING", 4_000, "a2", "Amos Mockery"),
      ev("PENDING", 1_000, "a1", "Agent One"),
    ])
    expect(rows).toEqual([
      { agentId: "a1", agentName: "Agent One", loans: 2, totals: expect.objectContaining({ pendingCents: 24_000 }) },
      { agentId: "a2", agentName: "Amos Mockery", loans: 1, totals: expect.objectContaining({ pendingCents: 4_000 }) },
    ])
  })

  it("orders by net owed descending, so the biggest liability is first", () => {
    const rows = summariseByAgent([ev("PENDING", 100, "a1", "Small"), ev("PENDING", 900, "a2", "Big")])
    expect(rows.map((r) => r.agentName)).toEqual(["Big", "Small"])
  })

  it("skips events with no agent rather than inventing a group", () => {
    expect(summariseByAgent([ev("PENDING", 100, null as unknown as string, "?")])).toEqual([])
  })
})
