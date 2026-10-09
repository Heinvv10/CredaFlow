import { sastStartOfDay } from "@/lib/date/sast"

// Recompute a loan's outstanding principal, arrears and days-in-arrears from its
// repayment schedule. ALL money is in CENTS. These three values are read directly
// by the Certificate of Balance and Statement (legal/court documents), so they
// must be derived from the schedule, not incrementally guessed.
//
// Audit F-14/F-15: the payment route previously subtracted the GROSS receipt from
// outstandingPrincipal (over-reducing it by the interest+fees portion) and hard-
// reset arrears/DPD to 0 on every payment. Both are fixed by recomputing here.

export interface ScheduleRowLike {
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  totalDue: number
  totalPaid: number
}

export interface LoanBalances {
  outstandingPrincipal: number
  arrearsAmount: number
  daysInArrears: number
  allInstalmentsPaid: boolean
}

export interface ReceiptLike {
  amount: number
  reversed?: boolean
  allocationStatus?: "ALLOCATED" | "UNAPPLIED" | "REFUNDED"
}

const MS_PER_DAY = 86_400_000

// Day-aligned to SAST midnight, so DPD and arrears are time-of-day independent
// and identical whether computed by a wall-clock payment or the DPD cron.
//
// The zone is load-bearing, not incidental. This was `setHours(0, 0, 0, 0)` —
// LOCAL midnight — and the container runs UTC, so between 00:00 and 02:00 SAST
// "today" was still yesterday. A payment captured at 00:30 on the due date was
// judged against the previous day and the instalment read as one day further
// into arrears than it was. DPD drives collections escalation and the s.129
// clock, so that hour band is not cosmetic.
function startOfDay(d: Date): number {
  return sastStartOfDay(d).getTime()
}

export function recomputeLoanBalances(
  principal: number,
  schedule: ScheduleRowLike[],
  asOf: Date,
): LoanBalances {
  const asOfDay = startOfDay(asOf)
  let principalPaid = 0
  let arrearsAmount = 0
  let earliestOverdueDay: number | null = null
  let allInstalmentsPaid = true

  for (const row of schedule) {
    // A payment fills charges (fees) and interest before principal, so the
    // principal portion realised on a row is whatever remains after both are
    // covered, capped at the row's principalDue (NCA s.126 payment order — and
    // robust to the fees-vs-interest sub-order, since both precede principal).
    const paidTowardPrincipal = Math.min(
      row.principalDue,
      Math.max(0, row.totalPaid - row.interestDue - row.feesDue),
    )
    principalPaid += paidTowardPrincipal

    const rowUnpaid = row.totalDue - row.totalPaid
    if (rowUnpaid > 0) {
      allInstalmentsPaid = false
      // Overdue once the due DAY has fully passed (an instalment due today is
      // not yet in arrears).
      const dueDay = startOfDay(row.dueDate)
      if (dueDay < asOfDay) {
        arrearsAmount += rowUnpaid
        if (earliestOverdueDay === null || dueDay < earliestOverdueDay) {
          earliestOverdueDay = dueDay
        }
      }
    }
  }

  const outstandingPrincipal = Math.max(0, principal - principalPaid)
  const daysInArrears = earliestOverdueDay !== null
    ? Math.max(0, Math.round((asOfDay - earliestOverdueDay) / MS_PER_DAY))
    : 0

  return { outstandingPrincipal, arrearsAmount, daysInArrears, allInstalmentsPaid }
}

/**
 * Allocate a total receipt amount across schedule rows, earliest due first,
 * filling each row up to its `totalDue` before moving to the next. Returns the
 * per-row `totalPaid` (same order as the input rows).
 *
 * Both the forward payment path and the reversal path must agree on the schedule
 * state implied by a set of receipts, so both derive it from this single pure
 * function. Reversal recomputes from the sum of the loan's NON-reversed receipts;
 * without a full re-derivation a reversal would leave rows marked PAID that the
 * remaining receipts no longer cover (audit N-01).
 */
export function allocateReceipts(
  rows: { totalDue: number }[],
  totalReceipts: number,
): number[] {
  let remaining = Math.max(0, totalReceipts)
  return rows.map((row) => {
    const apply = Math.min(remaining, Math.max(0, row.totalDue))
    remaining -= apply
    return apply
  })
}

/**
 * Remaining contractual balance after each receipt, in receipt order.
 *
 * Statements, account history and any other receipt-by-receipt projection must
 * start from the total contractual amount due, not principal. Reversed receipts
 * remain visible in history but have no displayed running balance and do not
 * reduce the balance used by subsequent rows.
 */
export function contractualRunningBalances(
  totalRepayable: number,
  receipts: ReceiptLike[],
): Array<number | null> {
  let remaining = Math.max(0, totalRepayable)

  return receipts.map((receipt) => {
    if (
      receipt.reversed
      || (
        receipt.allocationStatus !== undefined
        && receipt.allocationStatus !== "ALLOCATED"
      )
    ) return null
    remaining = Math.max(0, remaining - receipt.amount)
    return remaining
  })
}

/**
 * The dueDate of the earliest not-fully-paid instalment, or null if all paid.
 * Persist this to Loan.nextPaymentDate after a payment so the "next payment"
 * display and the DPD basis stay in sync with the schedule (audit F-15 — the
 * DPD cron previously derived DPD from a nextPaymentDate the payment paths never
 * updated, which could clobber the recomputed arrears).
 */
export function nextPaymentDueDate(schedule: ScheduleRowLike[]): Date | null {
  let earliest: Date | null = null
  for (const row of schedule) {
    if (row.totalPaid >= row.totalDue) continue
    if (!earliest || row.dueDate.getTime() < earliest.getTime()) earliest = row.dueDate
  }
  return earliest
}
