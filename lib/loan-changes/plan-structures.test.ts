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
    expect(plan.totalInterest).toBeLessThan(290_000)
  })

  it("at the same rate is unchanged", () => {
    const plan = bullet({ type: "RATE_CHANGE", interestRatePm: 0.04 })
    expect(plan.totalInterest).toBe(240_000)
    expect(plan.fresh[0]!.dueDate).toEqual(bulletRows(1_000_000)[0]!.dueDate)
  })

  const midway = at("2026-10-15") // 4.5 months into 6

  it("keeps the interest of the whole periods gone by, and prices only what remains", () => {
    const plan = bullet({ type: "RATE_CHANGE", interestRatePm: 0.02 }, midway)
    expect(plan.totalInterest).toBe(40_000 * 4 + 20_000 * 2)
    expect(plan.fresh[0]!.dueDate).toEqual(bulletRows(1_000_000)[0]!.dueDate)
  })

  it("a new term runs from the last period end, never before what accrued", () => {
    const plan = bullet({ type: "TERM_CHANGE", instalments: 5 }, midway)
    expect(plan.fresh[0]!.dueDate).toEqual(addCalendarMonths(START, 9))
    expect(plan.totalInterest).toBe(40_000 * 9)
    const shorter = bullet({ type: "TERM_CHANGE", instalments: 1 }, midway)
    expect(shorter.fresh[0]!.dueDate).toEqual(addCalendarMonths(START, 5))
    expect(shorter.totalInterest).toBe(40_000 * 5)
  })

  it("a loan shorter than half a period is still one period", () => {
    const start = at("2026-06-01")
    const rows = generateSchedule({ principalCents: 1_000_000, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate: start, terms: { frequency: "MONTHLY", structure: "BULLET", graceKind: "NONE", graceInstalments: 0, instalments: 1 } })
      .schedule.map((r, i): PlanRow => ({ id: `r${i}`, installmentNo: r.installmentNo, dueDate: at("2026-06-08"), principalDue: r.principalDue, interestDue: r.interestDue, feesDue: 0, totalDue: r.totalDue, totalPaid: 0, paidAt: null }))
    const plan = planInPlace({ loan: { principal: 1_000_000, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 0, startDate: start }, rows, frequency: "MONTHLY", structure: "BULLET", change: { type: "RATE_CHANGE", interestRatePm: 0.04 }, asOf: at("2026-06-02") })
    expect(plan.totalRepayable).toBe(1_040_000)
  })

  it("has no instalments to take a holiday from", () => {
    expect(() => bullet({ type: "PAYMENT_HOLIDAY", holidayInstalments: 1 })).toThrow(/reschedule/)
  })

  it("past its due date can only be rescheduled, at the amount owed", () => {
    expect(() => bullet({ type: "TERM_CHANGE", instalments: 1 }, at("2027-03-02"))).toThrow(/reschedule the arrears/)
    const plan = bullet({ type: "RESCHEDULE", firstDueDate: "2027-04-01" }, at("2027-03-02"))
    expect(plan.totalRepayable).toBe(1_240_000)
    expect(plan.daysInArrears).toBe(0)
  })
})

describe("spreadCarried", () => {
  it("lands every cent on the rows and marks what it carried", () => {
    const rows = [1, 2, 3].map(() => ({ principalDue: 100_000, interestDue: 10_000, feesDue: 5_000, totalDue: 115_000 }))
    const out = spreadCarried(rows, 100, 7, 10)
    expect(out.reduce((s, r) => s + r.principalDue, 0)).toBe(300_010)
    expect(out.reduce((s, r) => s + r.carriedPrincipalDue, 0)).toBe(10)
    expect(out.reduce((s, r) => s + r.interestDue, 0)).toBe(30_100)
    expect(out.reduce((s, r) => s + r.feesDue, 0)).toBe(15_007)
    expect(out.reduce((s, r) => s + r.carriedInterestDue, 0)).toBe(100)
    expect(out.reduce((s, r) => s + r.carriedFeesDue, 0)).toBe(7)
    for (const r of out) expect(r.totalDue).toBe(r.principalDue + r.interestDue + r.feesDue)
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
