import { describe, expect, it } from "vitest"
import { addCalendarMonths, addPeriods } from "@/lib/product-engine/periods"
import { planInPlace } from "./plan"
import { at, DAY, feesOf, input, interestOf, loanRows, monthly, rate, reconciles, START, totalOf, written } from "./plan.test-helpers"

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
