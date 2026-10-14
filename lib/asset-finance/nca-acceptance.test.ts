import { describe, expect, it } from "vitest"
import { assetFinanceNcaCapProblems } from "./nca-caps"
import { solveNcaDealStructure } from "./nca-structure"

const fixtures = [
  {
    name: "sole-proprietor TLB", contractType: "INSTALMENT_SALE" as const,
    asset: { cashPriceExclVatCents: 50_000_000, vatCents: 7_500_000 },
    depositCents: 5_750_000, tradeInCents: 0, balloonCents: 0, periods: 48, annualRate: "0.13",
    expected: { financed: 51_750_000, instalment: 1_394_603, interest: 14_902_933, total: 67_061_683 },
  },
  {
    name: "small-trust finance lease", contractType: "FINANCE_LEASE" as const,
    asset: { cashPriceExclVatCents: 30_000_000, vatCents: 4_500_000 },
    depositCents: 3_450_000, tradeInCents: 0, balloonCents: 6_900_000, periods: 36, annualRate: "0.13",
    expected: { financed: 31_050_000, instalment: 894_662, interest: 7_841_845, total: 39_228_595 },
  },
  {
    name: "trade-in delivery van", contractType: "INSTALMENT_SALE" as const,
    asset: { cashPriceExclVatCents: 80_000_000, vatCents: 12_000_000 },
    depositCents: 9_200_000, tradeInCents: 5_000_000, balloonCents: 10_000_000, periods: 60, annualRate: "0.18",
    expected: { financed: 77_800_000, instalment: 1_878_277, interest: 44_536_602, total: 122_817_352 },
  },
] as const

describe("NCA asset acceptance figures", () => {
  it.each(fixtures)("reproduces $name independently worked cents", (fixture) => {
    const initiationFeeCents = 120_750
    const solved = solveNcaDealStructure(fixture.asset, {
      depositCents: fixture.depositCents, tradeInCents: fixture.tradeInCents,
      financedFeesCents: initiationFeeCents, balloonCents: fixture.balloonCents,
      preset: "MONTHLY", weights: Array(fixture.periods).fill(1), firstDueDate: "2026-11-14",
      vatDeferralPeriodIndex: null,
      rate: { basis: "FIXED", fixedRate: fixture.annualRate, margin: null },
    }, { annualRate: fixture.annualRate, reference: null }, "2026-10-14")
    expect(solved.ok).toBe(true)
    if (!solved.ok) return
    expect(solved.result.financedAmountCents).toBe(fixture.expected.financed)
    expect(solved.result.baseInstalmentCents).toBe(fixture.expected.instalment)
    expect(solved.result.totalInterestCents).toBe(fixture.expected.interest)
    expect(solved.result.totalPayableCents).toBe(fixture.expected.total)
    expect(solved.result.totalPayableCents).toBe(
      fixture.expected.financed + fixture.expected.interest + initiationFeeCents + fixture.periods * 6_000,
    )
    expect(assetFinanceNcaCapProblems({
      contractType: fixture.contractType, repoAnnualRate: 0.0825, annualRate: Number(fixture.annualRate),
      principalCents: fixture.expected.financed, initiationFeeCents, monthlyServiceFeeCents: 6_000,
    })).toEqual([])
  })
})
