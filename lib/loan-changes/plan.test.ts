import { describe, expect, it } from "vitest"
import { addCalendarMonths, addPeriods } from "@/lib/product-engine/periods"
import { generateSchedule } from "@/lib/product-engine/schedule"
import type { RepaymentTerms } from "@/lib/product-engine/types"
import { planInPlace, type PlanInput, type PlanRow } from "./plan"

const DAY = 86_400_000
/** The instant of a SAST day at noon: dates here are fixed, so the suite is independent of the day it runs. */
const at = (day: string) => new Date(`${day}T10:00:00.000Z`)
const START = at("2026-01-15")
const NO_GRACE = { graceKind: "NONE", graceInstalments: 0 } as const
const monthly = (instalments: number, over: Partial<RepaymentTerms> = {}): RepaymentTerms => ({ frequency: "MONTHLY", structure: "AMORTISING", ...NO_GRACE, instalments, ...over })

interface LoanShape { principal?: number; rate?: number; model?: "REDUCING_BALANCE" | "FLAT"; fee?: number; start?: Date; terms?: RepaymentTerms }

/** The rows a booked loan really has: the engine's, with `paid` of them paid. */
function loanRows(shape: LoanShape = {}, paid = 0): PlanRow[] {
  const { principal = 600_000, rate = 0.04, model = "REDUCING_BALANCE", fee = 5_000, start = START, terms = monthly(6) } = shape
  return generateSchedule({ principalCents: principal, interestRatePm: rate, interestModel: model, monthlyServiceFeeCents: fee, startDate: start, terms }).schedule.map((r, i) => ({
    id: `r${i + 1}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue,
    totalPaid: i < paid ? r.totalDue : 0, paidAt: i < paid ? r.dueDate : null,
  }))
}

function input(rows: PlanRow[], change: PlanInput["change"], over: Partial<PlanInput> & { shape?: LoanShape } = {}): PlanInput {
  const { shape = {}, ...rest } = over
  return {
    loan: { principal: rows.reduce((s, r) => s + r.principalDue, 0), interestRatePm: shape.rate ?? 0.04, interestModel: shape.model ?? "REDUCING_BALANCE", monthlyServiceFee: shape.fee ?? 5_000, startDate: shape.start ?? START },
    rows, frequency: "MONTHLY", structure: "AMORTISING", asOf: at("2026-04-20"), change, ...rest,
  }
}

function reconciles(given: PlanInput, plan: ReturnType<typeof planInPlace>) {
  const rows = plan.rows
  expect(rows.reduce((s, r) => s + r.principalDue, 0)).toBe(given.loan.principal)
  expect(rows.reduce((s, r) => s + r.interestDue, 0)).toBe(plan.totalInterest)
  expect(rows.reduce((s, r) => s + r.totalDue, 0)).toBe(plan.totalRepayable)
  for (const r of rows) {
    expect(r.totalDue).toBe(r.principalDue + r.interestDue + r.feesDue)
    for (const value of [r.principalDue, r.interestDue, r.feesDue, r.totalDue]) expect(Number.isInteger(value) && value >= 0).toBe(true)
  }
}

const interestOf = (rows: readonly { interestDue: number }[]) => rows.reduce((s, r) => s + r.interestDue, 0)
const feesOf = (rows: readonly { feesDue: number }[]) => rows.reduce((s, r) => s + r.feesDue, 0)
const totalOf = (rows: readonly { totalDue: number }[]) => rows.reduce((s, r) => s + r.totalDue, 0)
const written = (plan: ReturnType<typeof planInPlace>): PlanRow[] => plan.rows.map((r, i) => ({ ...r, id: `n${i}`, paidAt: null }))
const rate = (interestRatePm: number) => ({ type: "RATE_CHANGE" as const, interestRatePm })

describe("planInPlace: what stays and what goes", () => {
  const threePaid = loanRows({}, 3)

  it("keeps paid rows untouched and reschedules only the unpaid principal", () => {
    const given = input(threePaid, rate(0.03))
    const plan = planInPlace(given)
    expect(plan.keep.map((r) => r.id)).toEqual(["r1", "r2", "r3"])
    expect(plan.remove).toEqual(["r4", "r5", "r6"])
    expect(plan.trim).toEqual([])
    expect(plan.balance).toBe(threePaid.slice(3).reduce((s, r) => s + r.principalDue, 0))
    expect(plan.fresh.map((r) => r.installmentNo)).toEqual([4, 5, 6])
    expect(plan.fresh.reduce((s, r) => s + r.principalDue, 0)).toBe(plan.balance)
    reconciles(given, plan)
  })

  it("keeps the dates of the instalments it does not move, month ends included", () => {
    const start = at("2026-01-31")
    const rows = loanRows({ start })
    const plan = planInPlace(input(rows, rate(0.03), { asOf: at("2026-02-10"), shape: { start } }))
    expect(plan.fresh[1]!.dueDate.toISOString().slice(0, 10)).toBe("2026-03-31")
    expect(plan.fresh.map((r) => r.dueDate)).toEqual(rows.map((r) => r.dueDate))
  })

  it("charges a new rate on the balance", () => {
    const plan = planInPlace(input(threePaid, rate(0.03)))
    expect(plan.fresh[0]!.interestDue).toBe(Math.round(plan.balance * 0.03))
  })

  it("money paid ahead on a row not yet due is all principal, and at the same rate moves nothing", () => {
    const rows = threePaid.map((r, i) => (i === 3 ? { ...r, totalPaid: 30_000 } : r))
    const plan = planInPlace(input(rows, rate(0.03)))
    expect(plan.trim[0]).toMatchObject({ principalDue: 30_000, interestDue: 0, feesDue: 0, totalDue: 30_000, totalPaid: 30_000 })
    expect(plan.balance).toBe(threePaid.slice(3).reduce((s, r) => s + r.principalDue, 0) - 30_000)
    reconciles(input(rows, rate(0.03)), plan)
    expect(planInPlace(input(rows, rate(0.04))).totalRepayable).toBe(totalOf(rows))
  })

  it("leaves rows already due as they are, and owed", () => {
    const rows = loanRows({}, 1) // rows 2 and 3 are overdue on 20 April
    const given = input(rows, rate(0.03))
    const plan = planInPlace(given)
    expect(plan.keep.map((r) => r.id)).toEqual(["r1", "r2", "r3"])
    expect(plan.remove).toEqual(["r4", "r5", "r6"])
    expect(plan.carriedInterest).toBe(0)
    expect(plan.balance).toBe(rows.slice(3).reduce((s, r) => s + r.principalDue, 0))
    expect(plan.arrearsAmount).toBe(rows[1]!.totalDue + rows[2]!.totalDue)
    expect(plan.nextPaymentDate).toEqual(rows[1]!.dueDate)
    expect(plan.fresh).toHaveLength(3)
    reconciles(given, plan)
  })

  it("leaves a part-paid row already due as it is", () => {
    const rows = loanRows({}, 2).map((r, i) => (i === 2 ? { ...r, totalPaid: 3_000 } : r))
    const plan = planInPlace(input(rows, rate(0.03)))
    expect(plan.trim).toEqual([])
    expect(plan.rows[2]).toMatchObject({ totalDue: rows[2]!.totalDue, totalPaid: 3_000 })
  })

  it("carries nothing on a loan up to date", () => {
    const plan = planInPlace(input(threePaid, rate(0.03)))
    expect(plan.carriedInterest).toBe(0)
    expect(plan.carriedFees).toBe(0)
  })

  it("a loan with every instalment left already due has nothing to change but its arrears", () => {
    for (const change of [{ type: "TERM_CHANGE" as const, instalments: 6 }, { type: "PAYMENT_HOLIDAY" as const, holidayInstalments: 1 }, rate(0.03)]) {
      expect(() => planInPlace(input(loanRows({}, 3), change, { asOf: at("2026-12-02") }))).toThrow(/reschedule the arrears/)
    }
  })

  it("refuses when nothing of the principal is left", () => {
    expect(() => planInPlace(input(loanRows({ terms: monthly(2) }, 2), rate(0.03)))).toThrow(/principal/)
  })

  it("keeps a fully prepaid future row and starts after it", () => {
    const rows = loanRows({}, 5)
    const plan = planInPlace(input(rows, rate(0.03)))
    expect(plan.keep).toHaveLength(5)
    expect(plan.fresh[0]!.dueDate).toEqual(rows[5]!.dueDate)
  })
})

describe("planInPlace: a change that changes nothing changes nothing", () => {
  it.each([["REDUCING_BALANCE" as const], ["FLAT" as const]])("%s at the same rate keeps every cent, whether or not any rows are paid", (model) => {
    for (const paid of [0, 1, 3, 5]) {
      const rows = loanRows({ model, principal: 1_000_000, terms: monthly(12) }, paid)
      const asOf = addCalendarMonths(START, paid).getTime() + DAY
      const plan = planInPlace(input(rows, rate(0.04), { asOf: new Date(asOf), shape: { model } }))
      expect(plan.totalRepayable).toBe(totalOf(rows))
      expect(plan.totalInterest).toBe(interestOf(rows))
    }
  })

  it("a deferred initiation fee on row 1 survives a change before row 1 falls due", () => {
    const rows = loanRows().map((r, i) => (i === 0 ? { ...r, feesDue: r.feesDue + 60_000, totalDue: r.totalDue + 60_000 } : r))
    const plan = planInPlace(input(rows, rate(0.03), { asOf: at("2026-02-01") }))
    expect(feesOf(plan.rows)).toBe(feesOf(rows))
    expect(plan.carriedFees).toBe(60_000)
  })

  it("a FULL grace's deferred interest survives, during the grace and after it", () => {
    const start = at("2026-02-01")
    const shape = { start, principal: 1_000_000, fee: 0, terms: monthly(9, { graceKind: "FULL", graceInstalments: 3 }) }
    const rows = loanRows(shape)
    expect(interestOf(rows)).toBeGreaterThan(120_000)
    const during = planInPlace(input(rows, rate(0.04), { asOf: at("2026-03-15"), shape }))
    expect(during.totalInterest).toBe(interestOf(rows))
    const paidTwo = loanRows(shape, 2)
    const after = planInPlace(input(paidTwo, rate(0.04), { asOf: addPeriods(paidTwo[1]!.dueDate, "MONTHLY", 0), shape }))
    expect(after.totalInterest).toBe(interestOf(rows))
  })

  it("a change during a FULL grace leaves the first instalment where it is: no arrears appear", () => {
    const start = at("2026-02-01")
    const shape = { start, fee: 0, terms: monthly(9, { graceKind: "FULL", graceInstalments: 3 }) }
    const rows = loanRows(shape)
    const plan = planInPlace(input(rows, rate(0.03), { asOf: at("2026-03-15"), shape }))
    expect(plan.fresh[0]!.dueDate).toEqual(rows[0]!.dueDate)
    expect(plan.daysInArrears).toBe(0)
  })

  it("a change during an earlier holiday neither moves the instalment nor charges the holiday twice", () => {
    const holiday = planInPlace(input(loanRows({}, 3), { type: "PAYMENT_HOLIDAY", holidayInstalments: 2 }))
    const again = planInPlace(input(written(holiday), rate(0.04), { asOf: at("2026-05-25") }))
    expect(again.fresh[0]!.dueDate).toEqual(holiday.fresh[0]!.dueDate)
    expect(again.totalRepayable).toBe(holiday.totalRepayable)
    expect(again.daysInArrears).toBe(0)
  })

  it("a change after a reschedule keeps the rescheduled date", () => {
    const moved = planInPlace(input(loanRows({}, 3), { type: "RESCHEDULE", firstDueDate: "2026-06-30" }))
    const again = planInPlace(input(written(moved), rate(0.04), { asOf: at("2026-05-25") }))
    expect(again.fresh[0]!.dueDate).toEqual(moved.fresh[0]!.dueDate)
    expect(again.totalRepayable).toBe(moved.totalRepayable)
  })

  it("a second change keeps what the first carried", () => {
    const first = planInPlace(input(loanRows({}, 3), { type: "PAYMENT_HOLIDAY", holidayInstalments: 2 }))
    const second = planInPlace(input(written(first), rate(0.04), { asOf: at("2026-04-21") }))
    expect(second.totalRepayable).toBe(first.totalRepayable)
  })
})

describe("planInPlace: the kinds of change", () => {
  const threePaid = loanRows({}, 3)

  it("a term change sets the number of remaining instalments", () => {
    const given = input(threePaid, { type: "TERM_CHANGE", instalments: 12 })
    const plan = planInPlace(given)
    expect(plan.fresh).toHaveLength(12)
    expect(plan.maturityDate).toEqual(plan.fresh[11]!.dueDate)
    reconciles(given, plan)
  })

  it("a payment holiday moves the next instalment by its periods and defers simple interest and the months' fees", () => {
    const given = input(threePaid, { type: "PAYMENT_HOLIDAY", holidayInstalments: 2 })
    const plan = planInPlace(given)
    expect(plan.fresh).toHaveLength(3)
    expect(plan.fresh[0]!.dueDate).toEqual(addPeriods(threePaid[3]!.dueDate, "MONTHLY", 2))
    expect(plan.terms).toMatchObject({ graceKind: "FULL", graceInstalments: 2, instalments: 5 })
    expect(plan.deferredInterest).toBe(Math.round(plan.balance * 0.04) * 2)
    expect(plan.carriedInterest).toBe(plan.deferredInterest)
    expect(plan.carriedFees).toBe(10_000)
    reconciles(given, plan)
  })

  it("a weekly holiday charges the week's rate, and rounds each period before multiplying", () => {
    const shape = { principal: 100_001, fee: 3_000, terms: monthly(8, { frequency: "WEEKLY" }), rate: 0.0433 }
    const rows = loanRows(shape, 2)
    const plan = planInPlace(input(rows, { type: "PAYMENT_HOLIDAY", holidayInstalments: 5 }, { frequency: "WEEKLY", shape, asOf: new Date(START.getTime() + 15 * DAY) }))
    expect(plan.deferredInterest).toBe(Math.round((plan.balance * 0.0433 * 12) / 52) * 5)
    expect(plan.terms.instalments).toBe(11)
  })

  it("a holiday's fee counts whole months, not periods", () => {
    const shape = { fee: 3_000, terms: monthly(8, { frequency: "WEEKLY" }) }
    const plan = planInPlace(input(loanRows(shape, 2), { type: "PAYMENT_HOLIDAY", holidayInstalments: 8 }, { frequency: "WEEKLY", shape, asOf: new Date(START.getTime() + 15 * DAY) }))
    expect(plan.carriedFees).toBeLessThan(8 * 3_000)
  })

  it("a reschedule moves the first date and charges the extra days as simple interest", () => {
    const given = input(threePaid, { type: "RESCHEDULE", firstDueDate: "2026-05-30" })
    const plan = planInPlace(given)
    expect(plan.fresh).toHaveLength(3)
    expect(plan.fresh[0]!.dueDate.toISOString().slice(0, 10)).toBe("2026-05-30")
    expect(plan.carriedInterest).toBe(Math.round((plan.balance * 0.04 * 15) / 30))
    expect(plan.totalRepayable).toBe(totalOf(threePaid) + plan.carriedInterest)
    reconciles(given, plan)
  })

  it("a reschedule moves arrears into the new rows at the amount owed: no new interest, every row after today", () => {
    const rows = loanRows({}, 1) // rows 2 and 3 are overdue on 20 April
    const given = input(rows, { type: "RESCHEDULE", firstDueDate: "2026-05-15" })
    const plan = planInPlace(given)
    expect(plan.fresh).toHaveLength(3)
    expect(plan.totalRepayable).toBe(totalOf(rows))
    expect(plan.carriedInterest).toBe(rows[1]!.interestDue + rows[2]!.interestDue)
    expect(plan.carriedFees).toBe(10_000)
    expect(plan.arrearsAmount).toBe(0)
    expect(plan.daysInArrears).toBe(0)
    expect(plan.fresh.every((r) => r.dueDate.getTime() > given.asOf.getTime())).toBe(true)
    expect(plan.fresh.reduce((s, r) => s + r.carriedInterestDue, 0)).toBe(plan.carriedInterest)
    reconciles(given, plan)
  })

  it("a reschedule splits a part-paid due row on what paid it: interest, then fees, then principal", () => {
    const rows = loanRows({}, 2).map((r, i) => (i === 2 ? { ...r, totalPaid: r.interestDue + r.feesDue + 5_000 } : r))
    const plan = planInPlace(input(rows, { type: "RESCHEDULE", firstDueDate: "2026-05-15" }))
    expect(plan.trim).toEqual([expect.objectContaining({ id: "r3", principalDue: 5_000, interestDue: rows[2]!.interestDue, feesDue: 5_000 })])
    expect(plan.totalRepayable).toBe(totalOf(rows))
  })

  it("a reschedule keeps what an earlier change carried, and marks it", () => {
    const first = planInPlace(input(loanRows({}, 1), { type: "RESCHEDULE", firstDueDate: "2026-05-15" }))
    const again = planInPlace(input(written(first), { type: "RESCHEDULE", firstDueDate: "2026-05-15" }, { asOf: at("2026-04-21") }))
    expect(again.totalRepayable).toBe(first.totalRepayable)
    expect(again.fresh.reduce((s, r) => s + r.carriedInterestDue, 0)).toBe(first.carriedInterest)
  })

  it("a reschedule past maturity makes one row of the arrears, and charges nothing for the time gone", () => {
    const rows = loanRows({}, 3)
    const plan = planInPlace(input(rows, { type: "RESCHEDULE", firstDueDate: "2027-01-15" }, { asOf: at("2026-12-20") }))
    expect(plan.fresh).toHaveLength(1)
    expect(plan.totalRepayable).toBe(totalOf(rows))
    expect(plan.daysInArrears).toBe(0)
  })

  it("a reschedule to a month end keeps the day it was asked for, across short months", () => {
    const plan = planInPlace(input(loanRows({}, 1), { type: "RESCHEDULE", firstDueDate: "2026-03-31" }, { asOf: at("2026-02-20") }))
    expect(plan.fresh[0]!.dueDate.toISOString().slice(0, 10)).toBe("2026-03-31")
  })

  it("refuses a reschedule to before the next instalment, which past maturity is the next period end ahead", () => {
    expect(() => planInPlace(input(threePaid, { type: "RESCHEDULE", firstDueDate: "2026-05-01" }))).toThrow(/next instalment/)
    expect(() => planInPlace(input(loanRows({}, 5), { type: "RESCHEDULE", firstDueDate: "2026-09-01" }, { asOf: at("2026-09-01") }))).toThrow(/next instalment/)
  })

  it("a FLAT loan's new rate is charged on the original principal, not the balance", () => {
    const shape = { model: "FLAT" as const, fee: 0, principal: 1_000_000, terms: monthly(12) }
    const rows = loanRows(shape, 3)
    const plan = planInPlace(input(rows, rate(0.02), { shape }))
    expect(plan.scheduleInterest).toBe(1_000_000 * 0.02 * 9)
    expect(plan.fresh[0]!.interestDue).toBe(20_000)
  })

  it("restructure takes rate and term together", () => {
    const given = input(threePaid, { type: "RESTRUCTURE", interestRatePm: 0.02, instalments: 24 })
    const plan = planInPlace(given)
    expect(plan.interestRatePm).toBe(0.02)
    expect(plan.fresh).toHaveLength(24)
    reconciles(given, plan)
  })

  it("weekly terms stay weekly, and a FLAT loan reconciles", () => {
    const shape = { model: "FLAT" as const, terms: monthly(3, { frequency: "WEEKLY" }) }
    const given = input(loanRows(shape, 1), { type: "TERM_CHANGE", instalments: 5 }, { frequency: "WEEKLY", shape, asOf: new Date(START.getTime() + 8 * DAY) })
    const plan = planInPlace(given)
    expect(plan.fresh[1]!.dueDate.getTime() - plan.fresh[0]!.dueDate.getTime()).toBe(7 * DAY)
    reconciles(given, plan)
  })
})
