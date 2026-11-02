import { describe, expect, it } from "vitest"
import { addPeriods } from "@/lib/product-engine/periods"
import { planInPlace } from "./plan"
import { at, DAY, input, loanRows, monthly, rate, reconciles, START, totalOf, written } from "./plan.test-helpers"

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

  it("a FLAT holiday charges the skipped periods on the original principal", () => {
    const shape = { model: "FLAT" as const, fee: 0, principal: 1_000_000, terms: monthly(12) }
    const plan = planInPlace(input(loanRows(shape, 3), { type: "PAYMENT_HOLIDAY", holidayInstalments: 2 }, { shape }))
    expect(plan.deferredInterest).toBe(80_000)
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

  it("the days a reschedule adds earn interest on what bears it, not on arrears principal it moved", () => {
    const rows = loanRows({}, 1)
    const plan = planInPlace(input(rows, { type: "RESCHEDULE", firstDueDate: "2026-05-30" }))
    const bearing = rows.slice(3).reduce((s, r) => s + r.principalDue, 0)
    expect(plan.carriedInterest - rows[1]!.interestDue - rows[2]!.interestDue).toBe(Math.round((bearing * 0.04 * 15) / 30))
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
