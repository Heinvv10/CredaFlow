import { describe, expect, it } from "vitest"
import { accruedInterestCents, eclCents, exposureAtDefault, proportionCents, unpaidScheduleAmounts, type ScheduleRow } from "./ecl"

describe("eclCents", () => {
  it("is EAD x PD x LGD: R10 000 at 5% PD and 45% LGD is R225.00", () => {
    expect(eclCents(1_000_000, 500, 4500)).toBe(22_500)
  })

  it("rounds to the nearest cent, half up", () => {
    // 12 345 x 3.33% x 40% = 164.4354
    expect(eclCents(12_345, 333, 4000)).toBe(164)
    // 1 x 50% x 100% = 0.5 -> 1; 3 x 50% x 100% = 1.5 -> 2; 2 x 50% x 100% = 1 exactly
    expect(eclCents(1, 5000, 10_000)).toBe(1)
    expect(eclCents(3, 5000, 10_000)).toBe(2)
    expect(eclCents(2, 5000, 10_000)).toBe(1)
  })

  it("is the whole exposure at 100% PD and LGD, and nothing at 0", () => {
    expect(eclCents(777_700, 10_000, 10_000)).toBe(777_700)
    expect(eclCents(777_700, 0, 4500)).toBe(0)
    expect(eclCents(0, 500, 4500)).toBe(0)
  })

  it("does not lose precision above 2^53 in the intermediate product", () => {
    // R100 000 000 000.00 = 1e13 cents x 10 000 x 10 000 = 1e21 in the numerator
    expect(eclCents(10_000_000_000_000, 10_000, 10_000)).toBe(10_000_000_000_000)
    // 2^53 - 1 is the largest safe integer; half of it is x.5, rounded up
    expect(eclCents(9_007_199_254_740_991, 5000, 10_000)).toBe(4_503_599_627_370_496)
  })

  it("refuses a negative or out-of-range input", () => {
    expect(() => eclCents(-1, 500, 4500)).toThrow()
    expect(() => eclCents(100, 10_001, 4500)).toThrow()
    expect(() => eclCents(100, 500, -1)).toThrow()
    expect(() => eclCents(1.5, 500, 4500)).toThrow()
  })
})

const row = (dueDate: string, interestDue: number, feesDue: number, principalDue: number, totalPaid: number): ScheduleRow => ({
  dueDate, interestDue, feesDue, principalDue, totalDue: interestDue + feesDue + principalDue, totalPaid,
})

describe("unpaidScheduleAmounts", () => {
  it("counts only instalments due on or before the run date, interest first then fees", () => {
    const rows = [
      row("2026-08-31", 1_000, 500, 8_500, 10_000), // fully paid
      row("2026-09-30", 900, 500, 8_600, 1_200),     // 1 200 paid: interest 900, fees 300 -> 200 fees unpaid, interest 0
      row("2026-10-31", 800, 500, 8_700, 0),         // due on the run date: raised, nothing paid
      row("2026-11-30", 700, 500, 8_800, 0),         // not yet due
    ]
    expect(unpaidScheduleAmounts(rows, "2026-10-31")).toEqual({ interestCents: 800, feesCents: 700 })
  })

  it("never goes negative on an over-paid instalment", () => {
    expect(unpaidScheduleAmounts([row("2026-08-31", 1_000, 500, 8_500, 12_000)], "2026-10-31")).toEqual({ interestCents: 0, feesCents: 0 })
  })
})

describe("accruedInterestCents", () => {
  const rows = [row("2026-09-30", 900, 0, 9_100, 10_000), row("2026-10-31", 3_100, 0, 6_900, 0)]

  it("accrues the next instalment's interest by the day since the previous due date", () => {
    // 10 of 31 days: 3 100 x 10 / 31 = 1 000
    expect(accruedInterestCents(rows, "2026-10-10", "2026-08-31")).toBe(1_000)
  })

  it("is nothing on the previous due date and the whole interest on the due date", () => {
    expect(accruedInterestCents(rows, "2026-09-30", "2026-08-31")).toBe(0)
  })

  it("starts from the loan start for the first instalment", () => {
    const first = [row("2026-10-31", 3_100, 0, 6_900, 0)]
    // start 2026-09-30, 10 of 31 days
    expect(accruedInterestCents(first, "2026-10-10", "2026-09-30")).toBe(1_000)
  })

  it("is reduced by what was already paid ahead on that instalment, and zero when none is left to accrue", () => {
    const prepaid = [row("2026-09-30", 900, 0, 9_100, 10_000), row("2026-10-31", 3_100, 0, 6_900, 400)]
    expect(accruedInterestCents(prepaid, "2026-10-10", "2026-08-31")).toBe(600)
    expect(accruedInterestCents([row("2026-09-30", 900, 0, 9_100, 0)], "2026-10-10", "2026-08-31")).toBe(0)
  })
})

describe("exposureAtDefault", () => {
  const base = {
    outstandingPrincipalCents: 800_000, unpaidInterestCents: 30_000, unpaidFeesCents: 5_000,
    chargesOutstandingCents: 12_000, accruedInterestCents: 7_000, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0,
  }

  it("is principal + unpaid interest and fees + charges + accrued interest for a performing loan", () => {
    expect(exposureAtDefault(base)).toBe(854_000)
  })

  it("leaves out interest held in suspense and does not accrue further interest", () => {
    // suspended: all raised unpaid interest (30 000) and 4 000 of the 12 000 charges are default interest
    const e = exposureAtDefault({ ...base, suspendedInterestCents: 30_000, suspendedDefaultInterestCents: 4_000, accruedInterestCents: 0 })
    expect(e).toBe(800_000 + 5_000 + 8_000)
  })
})

describe("proportionCents", () => {
  it("is amount x numerator / denominator to the nearest cent, half up", () => {
    // 40 000 x 316 800 / 528 000 = 24 000
    expect(proportionCents(40_000, 316_800, 528_000)).toBe(24_000)
    // 1 x 1 / 2 = 0.5 -> 1 ; 3 x 1 / 2 = 1.5 -> 2 ; 1 x 1 / 3 = 0.33 -> 0
    expect(proportionCents(1, 1, 2)).toBe(1)
    expect(proportionCents(3, 1, 2)).toBe(2)
    expect(proportionCents(1, 1, 3)).toBe(0)
  })

  it("is zero over a zero denominator and exact beyond 2^53 in the product", () => {
    expect(proportionCents(500, 0, 0)).toBe(0)
    expect(proportionCents(9_007_199_254_740_991, 9_007_199_254_740_991, 9_007_199_254_740_991)).toBe(9_007_199_254_740_991)
  })

  it("refuses a negative", () => {
    expect(() => proportionCents(-1, 1, 1)).toThrow()
  })
})

describe("exposureAtDefault clamp", () => {
  it("never goes below zero if more is suspended than was exposed", () => {
    expect(exposureAtDefault({
      outstandingPrincipalCents: 0, unpaidInterestCents: 1_000, unpaidFeesCents: 0, chargesOutstandingCents: 0, accruedInterestCents: 0,
      suspendedInterestCents: 1_000, suspendedDefaultInterestCents: 500,
    })).toBe(0)
  })
})
