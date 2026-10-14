import { describe, expect, it } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { allocateReceipt } from "@/lib/loan/receipt-allocation"
import { allocateReceipts, nextPaymentDueDate, recomputeLoanBalances } from "@/lib/loan/balances"
import { projectReceipt } from "@/lib/loan/settlement"
import { DebitMandateEvidenceError, debitMandatePaymentTerms } from "@/lib/loan/debit-mandate"
import { toDayNumber } from "./dates"
import { dueDateInstant, toScheduleRecord } from "./schedule-records"
import { BASE, PATTERNS, solvePattern } from "./__tests__/schedule-fixtures"

// The ledger's consumers against an asset-finance schedule with skip rows
// (totalDue 0) and capitalising rows (./schedule-records.ts ZERO ROWS).

const result = solvePattern(PATTERNS.BIANNUAL) // pays in March and September only
const records = result.rows.map(toScheduleRecord)
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
const principal = sum(records.map((r) => r.principalDue))
const totalRepayable = sum(records.map((r) => r.totalDue))
const skip = records.flatMap((r, i) => (r.totalDue === 0 ? [i] : []))
const dueDay = (i: number) => toDayNumber(result.rows[i].dueDate)
const firstPaying = records.findIndex((r) => r.totalDue > 0)
const secondPaying = records.findIndex((r, i) => i > firstPaying && r.totalDue > 0)

describe("receipt allocation (s126 and legacy order) on a skip schedule", () => {
  const rows = records.map((r, i) => ({ dueDay: dueDay(i), principalDue: r.principalDue, interestDue: r.interestDue, totalDue: r.totalDue }))
  const amounts = [1, 50_000, records[firstPaying].totalDue, records[firstPaying].totalDue + 1, totalRepayable]
  const days = [dueDay(0), dueDay(firstPaying), dueDay(secondPaying) - 1, dueDay(secondPaying), dueDay(records.length - 1)]

  it("never allocates anything to a skip row, nor more than a row's interest to its interest", () => {
    expect(skip.length).toBeGreaterThan(30)
    for (const s126 of [true, false]) for (const amount of amounts) for (const day of days) {
      const paid = rows.map(() => 0)
      const split = allocateReceipt({ amount, day, defaultInterestOwed: 0, chargesOwed: 0, rows, paid, s126 })
      for (const i of skip) expect(paid[i]).toBe(0)
      paid.forEach((p, i) => expect(p).toBeLessThanOrEqual(rows[i].totalDue))
      expect(split.toSchedule + split.unallocated).toBe(amount)
    }
  })

  it("s126: interest first fills only what each due row charges as interest", () => {
    const paid = rows.map(() => 0)
    const due = rows.flatMap((r, i) => (r.dueDay <= dueDay(secondPaying) ? [i] : []))
    const interestDue = sum(due.map((i) => rows[i].interestDue))
    allocateReceipt({ amount: interestDue, day: dueDay(secondPaying), defaultInterestOwed: 0, chargesOwed: 0, rows, paid, s126: true })
    due.forEach((i) => expect(paid[i]).toBe(rows[i].interestDue))
  })
})

describe("balances on a skip schedule", () => {
  const schedule = (paidThrough: number) => records.map((r, i) => ({
    dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue,
    totalPaid: i <= paidThrough ? r.totalDue : 0,
  }))

  it("reconciles when every row is paid: no principal outstanding, no arrears", () => {
    const after = recomputeLoanBalances(principal, schedule(records.length - 1), dueDateInstant("2031-01-01"))
    expect(after).toEqual({ outstandingPrincipal: 0, arrearsAmount: 0, daysInArrears: 0, allInstalmentsPaid: true })
  })

  it("never counts a passed skip row as arrears, and the outstanding principal is the unpaid scheduled capital", () => {
    // Paid through the first paying row; every skip row up to the day before
    // the second paying row has passed.
    const asOf = dueDateInstant(result.rows[secondPaying].dueDate)
    const after = recomputeLoanBalances(principal, schedule(firstPaying), asOf)
    expect(skip.filter((i) => i < secondPaying && i > firstPaying).length).toBeGreaterThan(3)
    expect(after.arrearsAmount).toBe(0)
    expect(after.daysInArrears).toBe(0)
    expect(after.outstandingPrincipal).toBe(sum(records.slice(firstPaying + 1).map((r) => r.principalDue)))
    expect(after.outstandingPrincipal).toBeGreaterThan(0)
    const next = nextPaymentDueDate(schedule(firstPaying))
    expect(next && sastCalendarDate(next)).toBe(result.rows[secondPaying].dueDate)
  })

  it("a receipt-total allocation skips the zero rows too", () => {
    const allocated = allocateReceipts(records, records[firstPaying].totalDue + records[secondPaying].totalDue)
    expect(allocated.filter((a) => a > 0).length).toBe(2)
    for (const i of skip) expect(allocated[i]).toBe(0)
  })
})

describe("settlement on a skip schedule", () => {
  it("settles at Σ totalDue less paid, allocating nothing to a skip row", () => {
    const projection = projectReceipt({
      loan: {
        principal, totalInterest: sum(records.map((r) => r.interestDue)), totalRepayable, totalPaid: 0,
        interestRatePm: BASE.ratePath[0].annualRate / 12, interestModel: "REDUCING_BALANCE",
        startDate: dueDateInstant(BASE.startDate), maturityDate: records[records.length - 1].dueDate,
      },
      schedule: records.map((r, i) => ({ ...r, id: `row-${i}`, totalPaid: 0 })),
      amount: totalRepayable,
      asOf: dueDateInstant(result.rows[firstPaying].dueDate),
    })
    expect(projection).toMatchObject({ settlementDue: totalRepayable, appliedAmount: totalRepayable, isCompleted: true })
    for (const i of skip) expect(projection.rows[i].totalPaid).toBe(0)
  })
})

describe("debit mandate", () => {
  it("refuses a schedule with a skip row (fails closed: an asset-finance loan has no debit-order mandate)", () => {
    expect(() => debitMandatePaymentTerms({
      schedule: records, principal, totalInterest: sum(records.map((r) => r.interestDue)), totalRepayable,
      initiationFee: 0, initiationFeePayment: "UPFRONT", startDate: dueDateInstant(BASE.startDate),
      maturityDate: records[records.length - 1].dueDate, affordabilityResult: null,
    })).toThrow(new DebitMandateEvidenceError("The repayment schedule is invalid and cannot support a debit mandate."))
  })
})
