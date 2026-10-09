import { AuditAction } from "@/lib/audit"
import { allocateReceipts } from "@/lib/loan/balances"
import type { ChargesTx } from "@/lib/loan/charges-replay"
import type { SyncActor } from "@/lib/loan/charges-sync"
import { allocateReceipt } from "@/lib/loan/receipt-allocation"

// When each instalment was paid. ALL money is CENTS.
//
// A row's paidAt is the value date of the live receipt whose schedule share
// completed it, when the loan's non-reversed ALLOCATED receipts are replayed in
// the books' order (value date, capture, id — as lib/loan/charges-replay.ts
// loads them) through the books' allocator, instalment by instalment. It is
// re-derived for EVERY row: reversing the receipt that paid an instalment on
// time, or booking one dated before a receipt already on the loan, changes
// which receipt completed a row whose amounts and status stay exactly the same.
//
// For loans whose default charges are off. On a charges-live loan
// syncLoanCharges re-dates the rows from its own s126 replay, and owns them.

export interface PaidAtReceipt {
  receivedAt: Date
  /** cents applied to the schedule: amount less what went to default charges */
  share: number
}

type PaidAtRow = { principalDue: number; interestDue: number; totalDue: number }

/** Completion date per row (rows in due-date order); null where the replay leaves a row short. */
export function replayPaidAt(rows: ReadonlyArray<PaidAtRow>, receipts: ReadonlyArray<PaidAtReceipt>): Array<Date | null> {
  // With s126 off the allocator fills instalment by instalment; dueDay is unread.
  const allocationRows = rows.map((row) => ({ ...row, dueDay: 0 }))
  const paid = rows.map(() => 0)
  const paidAt: Array<Date | null> = rows.map(() => null)
  for (const receipt of receipts) {
    const before = [...paid]
    allocateReceipt({
      amount: receipt.share, day: 0, rows: allocationRows, paid, s126: false, defaultInterestOwed: 0, chargesOwed: 0,
    })
    paid.forEach((p, i) => { if (before[i] < rows[i].totalDue && p >= rows[i].totalDue) paidAt[i] = receipt.receivedAt })
  }
  return paidAt
}

/**
 * Re-date every schedule row of a loan from the replay, writing only paidAt and
 * only where it moved. Run after the writer's Payment and schedule writes,
 * inside its transaction and loan lock.
 *
 * The replay is only trusted while it describes the schedule on the books: the
 * receipts' schedule shares must add up to what the rows record as paid, every
 * paid row must be one the replay completes, and each row must hold exactly
 * what the replay puts on it. Otherwise (a row marked
 * paid with no receipt behind it, say) it would move correct dates, so nothing
 * is re-dated and the skip is audited for someone to look at. Never throws for
 * that: the receipt itself is still booked.
 */
export async function restampSchedulePaidAt(
  tx: Pick<ChargesTx, "payment" | "repaymentSchedule" | "auditLog">,
  ref: { tenantId: string; loanId: string },
  actor: SyncActor,
): Promise<void> {
  const rows = await tx.repaymentSchedule.findMany({
    where: { tenantId: ref.tenantId, loanId: ref.loanId },
    orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }],
    select: { id: true, installmentNo: true, principalDue: true, interestDue: true, totalDue: true, totalPaid: true, paidAt: true },
  })
  const receipts = await tx.payment.findMany({
    where: { tenantId: ref.tenantId, loanId: ref.loanId, reversed: false, allocationStatus: "ALLOCATED" },
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { receivedAt: true, amount: true, defaultInterestAllocated: true, chargeFeesAllocated: true },
  })
  const shares = receipts.map((r) => ({
    receivedAt: r.receivedAt,
    share: r.amount - r.defaultInterestAllocated - r.chargeFeesAllocated,
  }))
  const replayed = replayPaidAt(rows, shares)
  const isPaid = (row: (typeof rows)[number]) => row.totalPaid >= row.totalDue

  const receiptShares = shares.reduce((sum, r) => sum + r.share, 0)
  const schedulePaid = rows.reduce((sum, row) => sum + row.totalPaid, 0)
  // A row that owes nothing is never completed by a receipt; it keeps its date.
  const undatable = rows.filter((row, i) => isPaid(row) && row.totalDue > 0 && replayed[i] === null)
  // Equal totals can still sit on different rows (two breaks that offset).
  const replayedPaid = allocateReceipts(rows, receiptShares)
  const mismatched = rows.filter((row, i) => row.totalPaid !== replayedPaid[i])
  const reason = receiptShares !== schedulePaid ? "ledger_identity_broken"
    : undatable.length > 0 ? "paid_row_not_completed_by_receipts"
      : mismatched.length > 0 ? "row_allocation_mismatch"
        : null
  if (reason) {
    const detail = {
      reason,
      source: actor.source,
      loanId: ref.loanId,
      receiptShares,
      schedulePaid,
      undatableInstalments: undatable.map((row) => row.installmentNo),
      mismatchedInstalments: mismatched.map((row) => row.installmentNo),
    }
    console.warn(`[schedule-paid-at] paidAt not re-dated for loan ${ref.loanId}: ${reason}`, detail)
    await tx.auditLog.create({
      data: {
        tenantId: ref.tenantId,
        userId: actor.userId ?? null,
        userEmail: actor.userEmail ?? null,
        action: AuditAction.SCHEDULE_PAIDAT_RESTAMP_SKIPPED,
        entity: "Loan",
        entityId: ref.loanId,
        newValue: detail,
      },
    })
    return
  }

  for (const [i, row] of rows.entries()) {
    const paidAt = !isPaid(row) ? null : row.totalDue > 0 ? replayed[i] : row.paidAt
    if (paidAt?.valueOf() === row.paidAt?.valueOf()) continue
    await tx.repaymentSchedule.update({ where: { id: row.id, tenantId: ref.tenantId }, data: { paidAt } })
  }
}
