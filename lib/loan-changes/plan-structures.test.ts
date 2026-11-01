import { describe, expect, it } from "vitest"
import { addCalendarMonths } from "@/lib/product-engine/periods"
import { generateSchedule } from "@/lib/product-engine/schedule"
import { planInPlace, spreadCarried, type PlanRow } from "./plan"
import { planNewLoan } from "./plan-new-loan"

const at = (day: string) => new Date(`${day}T10:00:00.000Z`)
const START = at("2026-06-01")
const bulletRows = (principal: number) => generateSchedule({ principalCents: principal, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate: START, terms: { frequency: "MONTHLY", structure: "BULLET", graceKind: "NONE", graceInstalments: 0, instalments: 6 } })
  .schedule.map((r, i): PlanRow => ({ id: `r${i}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: 0, paidAt: null }))
const bullet = (change: Parameters<typeof planInPlace>[0]["change"], asOf = at("2026-06-15")) => planInPlace({
  loan: { principal: 1_000_000, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 0, startDate: START },
  rows: bulletRows(1_000_000), frequency: "MONTHLY", structure: "BULLET", change, asOf,
})

describe("a single-payment (BULLET) loan", () => {
  it("rescheduled by one month owes one month more, not the whole term again", () => {
    const plan = bullet({ type: "RESCHEDULE", firstDueDate: "2027-01-01" })
    expect(plan.fresh).toHaveLength(1)
    expect(plan.fresh[0]!.dueDate.toISOString().slice(0, 10)).toBe("2027-01-01")
    expect(plan.totalInterest).toBeGreaterThanOrEqual(280_000)
    expect(plan.totalInterest).toBeLessThan(285_000)
  })

  it("at the same rate is unchanged", () => {
    const plan = bullet({ type: "RATE_CHANGE", interestRatePm: 0.04 })
    expect(plan.totalInterest).toBe(240_000)
    expect(plan.fresh[0]!.dueDate).toEqual(bulletRows(1_000_000)[0]!.dueDate)
  })

  it("takes a new term from the start of the period it is in", () => {
    const plan = bullet({ type: "TERM_CHANGE", instalments: 9 })
    expect(plan.fresh[0]!.dueDate).toEqual(addCalendarMonths(START, 9))
    expect(plan.totalInterest).toBe(360_000)
  })

  it("has no instalments to take a holiday from", () => {
    expect(() => bullet({ type: "PAYMENT_HOLIDAY", holidayInstalments: 1 })).toThrow(/reschedule/)
  })

  it("past its due date gets a date ahead", () => {
    const plan = bullet({ type: "TERM_CHANGE", instalments: 1 }, at("2027-03-02"))
    expect(plan.fresh[0]!.dueDate.getTime()).toBeGreaterThan(at("2027-03-02").getTime())
    expect(plan.daysInArrears).toBe(0)
  })
})

describe("spreadCarried", () => {
  it("lands every cent on the rows and marks what it carried", () => {
    const rows = [1, 2, 3].map(() => ({ interestDue: 10_000, feesDue: 5_000, totalDue: 115_000 }))
    const out = spreadCarried(rows, 100, 7)
    expect(out.reduce((s, r) => s + r.interestDue, 0)).toBe(30_100)
    expect(out.reduce((s, r) => s + r.feesDue, 0)).toBe(15_007)
    expect(out.reduce((s, r) => s + r.carriedInterestDue, 0)).toBe(100)
    expect(out.reduce((s, r) => s + r.carriedFeesDue, 0)).toBe(7)
    expect(out.map((r) => r.totalDue)).toEqual(rows.map((r, i) => r.totalDue + (out[i]!.interestDue - 10_000) + (out[i]!.feesDue - 5_000)))
  })
})

describe("planNewLoan", () => {
  const given = {
    settledCents: 250_012, newMoneyCents: 100_000, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE" as const, monthlyServiceFee: 5_000,
    frequency: "MONTHLY" as const, instalments: 7, asOf: at("2026-04-20"),
  }

  it("a new loan's principal is the settlement plus the new money, to the cent", () => {
    const plan = planNewLoan(given)
    expect(plan.principal).toBe(350_012)
    expect(plan.rows.reduce((s, r) => s + r.principalDue, 0)).toBe(350_012)
    expect(plan.totalRepayable).toBe(plan.rows.reduce((s, r) => s + r.totalDue, 0))
    expect(plan.totalInterest).toBe(plan.rows.reduce((s, r) => s + r.interestDue, 0))
  })

  it("starts today and pays nothing new on a pure refinance", () => {
    const plan = planNewLoan({ ...given, newMoneyCents: 0 })
    expect(plan.principal).toBe(250_012)
    expect(plan.rows[0]!.dueDate).toEqual(addCalendarMonths(at("2026-04-20"), 1))
  })
})
