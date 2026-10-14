import { describe, expect, it } from "vitest"
import { solveNcaDealStructure } from "./nca-structure"

const terms = {
  depositCents: 100_000, tradeInCents: 0, financedFeesCents: 20_000, balloonCents: 0,
  preset: "MONTHLY" as const, weights: [1, 1, 1], firstDueDate: "2027-02-01", vatDeferralPeriodIndex: null,
  rate: { basis: "FIXED" as const, fixedRate: "0.12", margin: null },
}

describe("NCA asset structure", () => {
  it("keeps the initiation fee outside principal and interest, and bills service fees per row", () => {
    const solved = solveNcaDealStructure(
      { cashPriceExclVatCents: 1_000_000, vatCents: 150_000 }, terms,
      { annualRate: "0.12", reference: null }, "2027-01-01",
    )
    expect(solved.ok).toBe(true)
    if (!solved.ok) return
    expect(solved.result.financedAmountCents).toBe(1_050_000)
    expect(solved.result.rows.map((row) => row.feesCents)).toEqual([26_000, 6_000, 6_000])
    expect(solved.result.totalPayableCents).toBe(
      solved.result.financedAmountCents + solved.result.totalInterestCents + 20_000 + 3 * 6_000,
    )
  })
})
