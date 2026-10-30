import { describe, expect, it } from "vitest"
import { calculateLoan, type LoanCalcInput } from "./loan-calculator"
import { ncaInitiationFeeCap } from "./loan/nca-fee-cap"
import type { RepaymentTerms } from "./product-engine/types"

const START = new Date("2027-02-10T12:00:00+02:00")
const base = (over: Partial<LoanCalcInput> = {}): LoanCalcInput => ({
  principal: 600_000, termDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.1,
  initiationFeeMax: 100_000, monthlyServiceFee: 6_900, productType: "PERSONAL", ...over,
})
const monthly: RepaymentTerms = { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 6 }
const weekly: RepaymentTerms = { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 12 }
const rows = (r: ReturnType<typeof calculateLoan>) => r.schedule.map((x) => [x.installmentNo, x.dueDate.toISOString(), x.principalDue, x.interestDue, x.feesDue, x.totalDue, x.openingBalance, x.closingBalance])

describe("calculateLoan with a repayment structure", () => {
  it("a monthly amortising structure is the existing instalment loan, to the cent: same schedule, totals and instalment, fee included", () => {
    const legacy = calculateLoan(base(), START)
    const engine = calculateLoan(base({ repayment: monthly }), START)
    expect(rows(engine)).toEqual(rows(legacy))
    expect({ ...engine, schedule: [] }).toEqual({ ...legacy, schedule: [] })
  })

  it("the same holds with the fee taken upfront", () => {
    const legacy = calculateLoan(base({ initiationFeePayment: "UPFRONT" }), START)
    const engine = calculateLoan(base({ initiationFeePayment: "UPFRONT", repayment: monthly }), START)
    expect(engine.disbursementAmount).toBe(legacy.disbursementAmount)
    expect(rows(engine)).toEqual(rows(legacy))
  })

  it("a weekly schedule foots: totalRepayable is the sum of the rows, the initiation fee sits on the first row, nothing is lost", () => {
    const r = calculateLoan(base({ repayment: weekly, termDays: 84, monthlyServiceFee: 6_900 }), START)
    expect(r.schedule).toHaveLength(12)
    expect(r.schedule.reduce((a, x) => a + x.totalDue, 0)).toBe(r.totalRepayable)
    expect(r.totalRepayable).toBe(r.principal + r.totalInterest + r.serviceFees + r.initiationFee)
    expect(r.schedule[0]!.feesDue).toBeGreaterThanOrEqual(r.initiationFee)
    expect(r.schedule.at(-1)!.closingBalance).toBe(0)
    // 12 weeks = 84 days = 3 months of the 30-day billing month: 3 service fees
    expect(r.serviceFees).toBe(3 * 6_900)
  })

  it("the monthly figure affordability reads is the weekly instalment x 52 / 12", () => {
    const r = calculateLoan(base({ repayment: weekly, monthlyServiceFee: 0 }), START)
    const regular = r.schedule[1]!.totalDue
    expect(r.monthlyInstalment).toBe(Math.round((regular * 52) / 12))
    expect(r.monthlyInstalment).toBeGreaterThan(regular)
  })

  it("the statutory initiation-fee ceiling still caps the fee on a new structure", () => {
    const r = calculateLoan(base({ repayment: weekly, principal: 300_000, initiationFeePct: 0.5, initiationFeeMax: 0 }), START)
    expect(r.initiationFee).toBe(Math.min(ncaInitiationFeeCap(300_000), Math.round(300_000 * 0.15)))
    expect(r.initiationFee).toBeLessThan(Math.round(300_000 * 0.5))
  })

  it("a bullet, an interest-only and a graced loan all foot", () => {
    for (const repayment of [
      { ...monthly, structure: "BULLET" as const },
      { ...monthly, structure: "INTEREST_ONLY" as const },
      { ...monthly, graceKind: "PRINCIPAL_ONLY" as const, graceInstalments: 2 },
      { ...monthly, graceKind: "FULL" as const, graceInstalments: 2 },
    ]) {
      const r = calculateLoan(base({ repayment }), START)
      expect(r.schedule.reduce((a, x) => a + x.totalDue, 0), JSON.stringify(repayment)).toBe(r.totalRepayable)
      expect(r.schedule.reduce((a, x) => a + x.principalDue, 0), JSON.stringify(repayment)).toBe(r.principal)
    }
  })

  it("refuses a repayment structure on a daily-accrual product", () => {
    expect(() => calculateLoan(base({ interestModel: "DAILY_ACCRUAL", repayment: monthly }), START)).toThrow(/FLAT or REDUCING_BALANCE/)
  })

  it("leaves every product without a structure exactly as it was: a 30-day daily-accrual micro loan", () => {
    const r = calculateLoan(base({ principal: 300_000, termDays: 30, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL", monthlyServiceFee: 6_900, initiationFeePct: 0, initiationFeeMax: 0 }), START)
    expect(r.schedule).toHaveLength(1)
    expect(r.totalInterest).toBe(15_000)
    expect(r.serviceFees).toBe(6_900)
  })
})

describe("the figure affordability reads for structures that are not an annuity (PR #266 review)", () => {
  const plain = { principal: 1_000_000, termDays: 56, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, productType: "PERSONAL", initiationFeePayment: "UPFRONT" as const }
  const terms = (t: Partial<RepaymentTerms> & { instalments: number }): RepaymentTerms => ({ frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, ...t })

  it("a weekly bullet is the one payment (R10 738), not that payment x 52 / 12", () => {
    const r = calculateLoan({ ...plain, repayment: terms({ frequency: "WEEKLY", structure: "BULLET", instalments: 8 }) }, START)
    expect(r.schedule).toHaveLength(1)
    expect(r.monthlyInstalment).toBe(r.schedule[0]!.totalDue)
  })

  it("a monthly interest-only loan is its interest, R400 on R10 000 at 4%, not the balloon R10 400", () => {
    const r = calculateLoan({ ...plain, termDays: 360, repayment: terms({ structure: "INTEREST_ONLY", instalments: 12 }) }, START)
    expect(r.monthlyInstalment).toBe(40_000)
  })
})

describe("month-end due dates (PR #266 review): the legacy schedule every NCA lender keeps is not touched; a structured one clamps", () => {
  const start = new Date("2026-01-31T08:00:00Z")
  const inp = { principal: 500_000, termDays: 90, interestRatePm: 0.05, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900, productType: "PERSONAL_LOAN" }
  const days = (r: { schedule: Array<{ dueDate: Date }> }) => r.schedule.map((x) => x.dueDate.toISOString().slice(0, 10))

  it("without a structure a loan started on the 31st is due on 3 March, as it always was (Date#setMonth spills February into March)", () => {
    expect(days(calculateLoan(inp, start))[0]).toBe("2026-03-03")
  })

  it("with a structure the same loan is due on the last day of February: the engine keeps the day of the month and clamps", () => {
    expect(days(calculateLoan({ ...inp, repayment: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 3 } }, start))).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"])
  })
})
