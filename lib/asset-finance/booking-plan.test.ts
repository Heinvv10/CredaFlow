import { describe, expect, it } from "vitest"
import { INT4_MAX } from "@/lib/product-config/bounds"
import { BookingAmountError, planBooking } from "./booking-plan"
import { dueDateInstant } from "./schedule-records"
import { solveStructure } from "./structure"
import { skipN } from "./structure-presets"
import type { StructureInput } from "./types"

// Synthetic: R1 725 000 incl. VAT, R172 500 deposit, R200 000 balloon,
// 36 months at 11.75%, first due two months after the start.
const DEAL: StructureInput = {
  cashPriceCents: 172_500_000,
  depositCents: 17_250_000,
  tradeInCents: 0,
  financedFeesCents: 0,
  balloonCents: 20_000_000,
  weights: new Array(36).fill(1),
  startDate: "2026-10-13",
  firstDueDate: "2026-12-13",
  ratePath: [{ effectiveDate: "2026-10-13", annualRate: 0.1175 }],
}

describe("planBooking", () => {
  it("writes the solver's rows; loan totals are their sums and the balloon closes the last row", () => {
    const result = solveStructure(DEAL)
    const plan = planBooking({ result, startDate: DEAL.startDate, balloonCents: DEAL.balloonCents, payoutCents: 155_250_000 })
    const sum = (pick: (r: (typeof plan.records)[number]) => number) => plan.records.reduce((t, r) => t + pick(r), 0)
    expect(plan.records).toHaveLength(36)
    expect(plan.principal).toBe(sum((r) => r.principalDue))
    expect(plan.totalInterest).toBe(sum((r) => r.interestDue))
    expect(plan.totalRepayable).toBe(sum((r) => r.totalDue))
    // No skip rows: capital repaid = financed amount; cost of credit = all interest.
    expect(plan.principal).toBe(result.financedAmountCents)
    expect(plan.totalRepayable).toBe(result.financedAmountCents + result.totalInterestCents)
    expect(plan.records[35].principalDue).toBeGreaterThan(DEAL.balloonCents)
    expect(plan.baseInstalmentCents).toBe(result.baseInstalmentCents)
    expect(plan.startDate).toEqual(dueDateInstant("2026-10-13"))
    expect(plan.nextPaymentDate).toEqual(dueDateInstant("2026-12-13"))
    expect(plan.maturityDate).toEqual(dueDateInstant("2029-11-13"))
  })

  it("capitalised interest of skip rows is principal later; the next payment skips zero rows", () => {
    const weights = skipN(12, 3)
    const result = solveStructure({ ...DEAL, weights, balloonCents: 0 })
    const plan = planBooking({ result, startDate: DEAL.startDate, balloonCents: 0, payoutCents: 155_250_000 })
    expect(plan.records[0].totalDue).toBe(0)
    expect(plan.principal).toBeGreaterThan(result.financedAmountCents)
    expect(plan.totalRepayable).toBe(result.financedAmountCents + result.totalInterestCents)
    expect(plan.nextPaymentDate).toEqual(plan.records.find((r) => r.totalDue > 0)?.dueDate)
  })

  it("refuses an amount that does not fit a 32-bit money column, naming it", () => {
    const result = solveStructure(DEAL)
    expect(() => planBooking({ result, startDate: DEAL.startDate, balloonCents: DEAL.balloonCents, payoutCents: INT4_MAX + 1 }))
      .toThrow(BookingAmountError)
    const big = solveStructure({ ...DEAL, cashPriceCents: 2_000_000_000, depositCents: 0, balloonCents: 0 })
    expect(() => planBooking({ result: big, startDate: DEAL.startDate, balloonCents: 0, payoutCents: 1 })).toThrow(/totalRepayable/)
  })
})
