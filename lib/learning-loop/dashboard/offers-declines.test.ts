import { describe, expect, it } from "vitest"
import type { OutcomeRow } from "./cells"
import { declineVolume, offerTakeUp, UNCATEGORISED } from "./offers-declines"

const takeUp = (state: OutcomeRow["state"], value: boolean | null): OutcomeRow[] =>
  [{ outcomeKind: "TAKEN_UP", window: "OFFER", state, value, reasonCode: null }]

describe("offerTakeUp", () => {
  it("counts taken up, not taken up and pending per month and offer type; pending is outside the rate", () => {
    const cells = offerTakeUp([
      { month: "2026-05", decision: "APPROVED_TERMS", outcomes: takeUp("OBSERVED", true) },
      { month: "2026-05", decision: "APPROVED_TERMS", outcomes: takeUp("OBSERVED", false) },
      { month: "2026-05", decision: "APPROVED_TERMS", outcomes: takeUp("PENDING", null) },
      { month: "2026-05", decision: "QUOTATION_ISSUED", outcomes: takeUp("OBSERVED", true) },
      { month: "2026-04", decision: "APPROVED_TERMS", outcomes: [] },
    ])
    expect(cells.map((c) => [c.month, c.decision, c.offers, c.takeUp.yes, c.takeUp.no, c.takeUp.pending, c.takeUp.ratePct])).toEqual([
      ["2026-05", "APPROVED_TERMS", 3, 1, 1, 1, 50],
      ["2026-05", "QUOTATION_ISSUED", 1, 1, 0, 0, 100],
      ["2026-04", "APPROVED_TERMS", 1, 0, 0, 0, null],
    ])
    expect(cells[2].takeUp.notComputed).toBe(1)
    expect(cells.every((c) => c.small)).toBe(true)
  })
})

describe("declineVolume", () => {
  it("counts declines by month and category, an uncategorised decline included", () => {
    const s = declineVolume([
      { month: "2026-05", category: "AFFORDABILITY", actorType: "STAFF", refusalReason: null, s71ReviewRequired: false },
      { month: "2026-05", category: "AFFORDABILITY", actorType: "STAFF", refusalReason: null, s71ReviewRequired: false },
      { month: "2026-05", category: null, actorType: "STAFF", refusalReason: null, s71ReviewRequired: false },
      { month: "2026-04", category: "BUREAU_SCORE", actorType: "STAFF", refusalReason: null, s71ReviewRequired: false },
    ])
    expect(s.cells).toEqual([
      { month: "2026-05", category: "AFFORDABILITY", declines: 2 },
      { month: "2026-05", category: UNCATEGORISED, declines: 1 },
      { month: "2026-04", category: "BUREAU_SCORE", declines: 1 },
    ])
    expect(s).toMatchObject({ total: 4, byCategory: { AFFORDABILITY: 2, UNCATEGORISED: 1, BUREAU_SCORE: 1 }, automated: { total: 0, s71ReviewRequired: 0, byReason: {} } })
  })

  it("counts refusals the code made alone (actorType SYSTEM) apart from staff declines, by reason, with the s71 review flag", () => {
    const s = declineVolume([
      { month: "2026-05", category: null, actorType: "SYSTEM", refusalReason: "client_blacklisted", s71ReviewRequired: true },
      { month: "2026-05", category: null, actorType: "SYSTEM", refusalReason: "client_blacklisted", s71ReviewRequired: true },
      { month: "2026-05", category: null, actorType: "SYSTEM", refusalReason: "identity_conflict", s71ReviewRequired: true },
      { month: "2026-05", category: "POLICY", actorType: "STAFF", refusalReason: null, s71ReviewRequired: false },
    ])
    expect(s.automated).toEqual({ total: 3, s71ReviewRequired: 3, byReason: { client_blacklisted: 2, identity_conflict: 1 } })
    // An automated refusal is not a staff decline.
    expect(s).toMatchObject({ total: 1, byCategory: { POLICY: 1 } })
    expect(s.cells).toEqual([{ month: "2026-05", category: "POLICY", declines: 1 }])
  })
})
