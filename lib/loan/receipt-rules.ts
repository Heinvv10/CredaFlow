/**
 * Marks the half of an over-payment the client is owed back. Read by the
 * reconcile screen, which turns it into a REFUNDED receipt once staff have
 * actually paid the money out.
 */
export const OVERPAYMENT_REASON = "overpayment_refund_due"

/**
 * Pure decision rules for capturing a receipt. Kept free of Prisma so both the
 * manual-capture path and its tests exercise the same logic without a database.
 */

/** Structural view of an already-committed receipt plus any refund-due sibling. */
export interface CommittedReceipt {
  loanId: string
  amount: number
  paymentMethod: string
  reference: string | null
  notes: string | null
  capturedBy: string | null
  excessPayments?: { amount: number }[]
}

export interface ReceiptRequest {
  loanId: string
  amount: number
  paymentMethod: string
  reference: string | null
  notes: string | null
  capturedById: string
}

/**
 * Total money a committed receipt represents.
 *
 * An over-payment is stored as an allocated row plus a refund-due sibling, so a
 * request must be matched against the GROUP total. Comparing it to the
 * allocated row alone rejects a legitimate retry as a conflict — and staff
 * retrying with a fresh key would bank the client's money a second time.
 */
export function receiptGroupTotal(existing: CommittedReceipt): number {
  return (existing.excessPayments ?? []).reduce(
    (sum, row) => sum + row.amount,
    existing.amount,
  )
}

/**
 * Whether a keyed request is an exact replay of one already committed.
 */
export function isSameReceiptRequest(
  existing: CommittedReceipt,
  request: ReceiptRequest,
): boolean {
  return existing.loanId === request.loanId
    && receiptGroupTotal(existing) === request.amount
    && existing.paymentMethod === request.paymentMethod
    && existing.reference === request.reference
    && existing.notes === request.notes
    && existing.capturedBy === request.capturedById
}

