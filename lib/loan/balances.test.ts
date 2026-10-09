import { describe, it, expect } from "vitest"
import {
  allocateReceipts,
  contractualRunningBalances,
  recomputeLoanBalances,
  type ScheduleRowLike,
} from "./balances"

const day = (offsetDays: number) => new Date(2026, 0, 1 + offsetDays)
const NOW = day(40)

// A 3-instalment reducing-balance-ish schedule (cents). Principal column sums to
// the loan principal (20000 -> 1409.24 + ... is the audit case; here use round nums).
function schedule(): ScheduleRowLike[] {
  return [
    { dueDate: day(10), principalDue: 600_000, interestDue: 60_000, feesDue: 6_900, totalDue: 666_900, totalPaid: 0 },
    { dueDate: day(20), principalDue: 650_000, interestDue: 40_000, feesDue: 6_900, totalDue: 696_900, totalPaid: 0 },
    { dueDate: day(30), principalDue: 750_000, interestDue: 20_000, feesDue: 6_900, totalDue: 776_900, totalPaid: 0 },
  ]
}
const PRINCIPAL = 2_000_000 // 600k + 650k + 750k

describe("recomputeLoanBalances", () => {
  it("F-14: reduces principal by the PRINCIPAL portion only, not the gross receipt", () => {
    // Pay instalment 1 in full (R6,669.00). Gross-subtraction would drop principal
    // to 2,000,000 - 666,900 = 1,333,100. Correct is 2,000,000 - 600,000 = 1,400,000.
    const s = schedule()
    s[0].totalPaid = 666_900
    const b = recomputeLoanBalances(PRINCIPAL, s, day(11))
    expect(b.outstandingPrincipal).toBe(1_400_000) // not 1,333,100
  })

  it("F-15: a partial payment does NOT zero genuine arrears/DPD", () => {
    // Instalments 1 & 2 overdue (due day10/day20, now day40). Client pays R1.00
    // toward instalment 1. Arrears must remain ~both overdue instalments, DPD from
    // the earliest overdue due date (day10 -> 30 days).
    const s = schedule()
    s[0].totalPaid = 100 // R1.00 — token payment
    const b = recomputeLoanBalances(PRINCIPAL, s, NOW)
    // All three instalments (due day10/20/30) are overdue at NOW=day40.
    expect(b.arrearsAmount).toBe(666_900 - 100 + 696_900 + 776_900)
    expect(b.daysInArrears).toBe(30) // day40 - day10 (earliest overdue)
    expect(b.outstandingPrincipal).toBe(PRINCIPAL) // R1 went to fees, not principal
  })

  it("arrears excludes future-dated unpaid instalments", () => {
    const s = schedule() // due day10/20/30, asOf day25 -> only 1 & 2 overdue
    const b = recomputeLoanBalances(PRINCIPAL, s, day(25))
    expect(b.arrearsAmount).toBe(666_900 + 696_900) // instalment 3 (day30) not yet due
    expect(b.daysInArrears).toBe(15) // day25 - day10
  })

  it("fully-paid schedule → zero outstanding, zero arrears, allInstalmentsPaid", () => {
    const s = schedule().map(r => ({ ...r, totalPaid: r.totalDue }))
    const b = recomputeLoanBalances(PRINCIPAL, s, day(60))
    expect(b.outstandingPrincipal).toBe(0)
    expect(b.arrearsAmount).toBe(0)
    expect(b.daysInArrears).toBe(0)
    expect(b.allInstalmentsPaid).toBe(true)
  })

  it("current loan (nothing overdue, nothing paid) → full principal, no arrears", () => {
    const b = recomputeLoanBalances(PRINCIPAL, schedule(), day(5))
    expect(b.outstandingPrincipal).toBe(PRINCIPAL)
    expect(b.arrearsAmount).toBe(0)
    expect(b.daysInArrears).toBe(0)
    expect(b.allInstalmentsPaid).toBe(false)
  })

  it("DPD/arrears are time-of-day independent (afternoon payment == midnight cron)", () => {
    const due = new Date(2026, 0, 10, 9, 30) // due Jan 10 09:30
    const rows: ScheduleRowLike[] = [
      { dueDate: due, principalDue: 100_000, interestDue: 0, feesDue: 0, totalDue: 100_000, totalPaid: 0 },
    ]
    const afternoon = recomputeLoanBalances(100_000, rows, new Date(2026, 0, 40, 17, 0))
    const midnight = recomputeLoanBalances(100_000, rows, new Date(2026, 0, 40, 0, 0))
    expect(afternoon.daysInArrears).toBe(midnight.daysInArrears)
    expect(afternoon.daysInArrears).toBe(30) // Jan(40) - Jan(10), day-aligned
    expect(afternoon.arrearsAmount).toBe(midnight.arrearsAmount)
  })

  it("an instalment due today is NOT yet in arrears", () => {
    const today = new Date(2026, 0, 20, 14, 0)
    const rows: ScheduleRowLike[] = [
      { dueDate: new Date(2026, 0, 20, 8, 0), principalDue: 100_000, interestDue: 0, feesDue: 0, totalDue: 100_000, totalPaid: 0 },
    ]
    const b = recomputeLoanBalances(100_000, rows, today)
    expect(b.arrearsAmount).toBe(0)
    expect(b.daysInArrears).toBe(0)
  })

  it("partial principal: row paid past fees+interest counts only the excess toward principal", () => {
    const s = schedule()
    // Pay fees+interest+R100 of principal on row 1: 6,900 + 60,000 + 100 = 67,000
    s[0].totalPaid = 67_000
    const b = recomputeLoanBalances(PRINCIPAL, s, day(5))
    expect(b.outstandingPrincipal).toBe(PRINCIPAL - 100)
  })
})

const TOTAL_REPAYABLE = 666_900 + 696_900 + 776_900 // 2,140,700

describe("allocateReceipts (N-01/N-02 — payment/reversal derive schedule state)", () => {
  it("fills instalments earliest-first up to each totalDue", () => {
    const s = schedule()
    // One receipt of instalment-1 + half of instalment-2.
    const per = allocateReceipts(s, 666_900 + 348_450)
    expect(per).toEqual([666_900, 348_450, 0])
  })

  it("never allocates past the schedule total (excess is not applied)", () => {
    const s = schedule()
    const per = allocateReceipts(s, TOTAL_REPAYABLE + 500_000) // R5,000 over
    expect(per).toEqual([666_900, 696_900, 776_900]) // capped at each totalDue
    expect(per.reduce((a, b) => a + b, 0)).toBe(TOTAL_REPAYABLE) // no phantom overpay
  })

  it("zero receipts leaves every row unpaid", () => {
    expect(allocateReceipts(schedule(), 0)).toEqual([0, 0, 0])
  })

  it("N-01: reversing the settling receipt restores the exact pre-payment state", () => {
    // Settle the loan with two receipts (R6,669.00 then the remainder), then
    // reverse the second. The remaining receipt (R6,669.00) must re-derive to:
    //   row1 PAID, rows 2/3 unpaid, outstanding = principal - row1.principalDue.
    // The pre-fix bug added the GROSS reversed amount to outstandingPrincipal and
    // left rows 2/3 marked PAID.
    const s = schedule()
    const firstReceipt = 666_900
    // After reversal, remaining non-reversed receipts = just the first one.
    const per = allocateReceipts(s, firstReceipt)
    const postRows = s.map((r, i) => ({ ...r, totalPaid: per[i] }))

    expect(per).toEqual([666_900, 0, 0])
    const b = recomputeLoanBalances(PRINCIPAL, postRows, day(5))
    expect(b.outstandingPrincipal).toBe(PRINCIPAL - 600_000) // row1 principal only
    expect(postRows[0].totalPaid).toBe(postRows[0].totalDue)  // row1 PAID
    expect(postRows[1].totalPaid).toBe(0)                     // row2 back to unpaid
    expect(postRows[2].totalPaid).toBe(0)                     // row3 back to unpaid
    // totalPaid the loan should carry = sum of remaining receipts, never gross-added.
    expect(per.reduce((a, b) => a + b, 0)).toBe(firstReceipt)
  })

  it("reversing the ONLY receipt returns the loan to zero paid, full principal", () => {
    const s = schedule()
    const per = allocateReceipts(s, 0) // all receipts reversed
    const postRows = s.map((r, i) => ({ ...r, totalPaid: per[i] }))
    const b = recomputeLoanBalances(PRINCIPAL, postRows, day(5))
    expect(b.outstandingPrincipal).toBe(PRINCIPAL)
    expect(postRows.every(r => r.totalPaid === 0)).toBe(true)
  })
})

describe("contractualRunningBalances", () => {
  it("uses total repayable for the walkthrough payment pattern", () => {
    expect(
      contractualRunningBalances(633_496, [
        { amount: 266_165 },
        { amount: 266_165 },
        { amount: 101_166 },
      ]),
    ).toEqual([367_331, 101_166, 0])
  })

  it("shows no balance for a reversed row and preserves it for later receipts", () => {
    expect(
      contractualRunningBalances(100_000, [
        { amount: 25_000 },
        { amount: 25_000, reversed: true },
        { amount: 10_000 },
      ]),
    ).toEqual([75_000, null, 65_000])
  })

  it("shows unapplied and refunded receipts without reducing the loan balance", () => {
    expect(
      contractualRunningBalances(100_000, [
        { amount: 25_000 },
        { amount: 50_000, allocationStatus: "UNAPPLIED" },
        { amount: 20_000, allocationStatus: "REFUNDED" },
        { amount: 10_000, allocationStatus: "ALLOCATED" },
      ]),
    ).toEqual([75_000, null, null, 65_000])
  })

  it("never renders a negative contractual balance", () => {
    expect(contractualRunningBalances(10_000, [{ amount: 12_000 }])).toEqual([0])
  })
})

describe("SAST day alignment", () => {
  // DPD and arrears are decided by which DAY a moment falls on, and the
  // container has no TZ — so before this, "today" ran on UTC and the South
  // African day between 00:00 and 02:00 was still counted as yesterday. These
  // pin the two hours where the answer differs. Everything else is unchanged.
  const schedule = (dueDate: Date) => [
    { dueDate, principalDue: 100_000, interestDue: 0, feesDue: 0, totalDue: 100_000, totalPaid: 0 },
  ]

  // Named for what it is: this one passes under BOTH the old and the new
  // alignment. It is here to pin that the fix did not widen anything, not to
  // prove the fix — the discriminating cases are the two below.
  it("regression guard: an instalment due today is not in arrears at 00:30 SAST", () => {
    // Due 20 Aug (13:00 SAST, a real schedule row's wall-clock time).
    // asOf = 2026-08-19T22:30Z = 00:30 SAST on 20 Aug — the SAME SAST day.
    // Under UTC alignment "today" was still the 19th, so the row was not yet
    // overdue either; the failure is the mirror case below.
    const b = recomputeLoanBalances(
      100_000,
      schedule(new Date("2026-08-20T11:00:00Z")),
      new Date("2026-08-19T22:30:00Z"),
    )
    expect(b.arrearsAmount).toBe(0)
    expect(b.daysInArrears).toBe(0)
  })

  it("counts the day that has passed in SAST, not the one UTC is still on", () => {
    // Due 19 Aug. asOf = 2026-08-19T22:30Z = 00:30 SAST on 20 Aug, so in
    // Johannesburg the due day is over and the loan IS one day down.
    // UTC alignment read "today = 19 Aug" and reported 0 days in arrears —
    // a day of DPD invisible to collections and to the s.129 clock.
    const b = recomputeLoanBalances(
      100_000,
      schedule(new Date("2026-08-19T11:00:00Z")),
      new Date("2026-08-19T22:30:00Z"),
    )
    expect(b.arrearsAmount).toBe(100_000)
    expect(b.daysInArrears).toBe(1)
  })

  it("aligns an instalment due late in the SAST evening to its own day", () => {
    // Due 2026-08-20T22:30Z — 00:30 SAST on the 21st, i.e. a 21 Aug instalment.
    // asOf = 21 Aug 09:00 SAST. It is due TODAY, so not in arrears.
    // Under UTC the due row read as the 20th and showed a day of arrears.
    const b = recomputeLoanBalances(
      100_000,
      schedule(new Date("2026-08-20T22:30:00Z")),
      new Date("2026-08-21T07:00:00Z"),
    )
    expect(b.arrearsAmount).toBe(0)
    expect(b.daysInArrears).toBe(0)
  })

  it("is unchanged during the 22 hours a day where UTC and SAST agree", () => {
    const b = recomputeLoanBalances(
      100_000,
      schedule(new Date("2026-08-10T11:00:00Z")),
      new Date("2026-08-20T09:00:00Z"),
    )
    expect(b.daysInArrears).toBe(10)
  })
})
