/**
 * Shapes shared by the source derivation (lib/accounting/sources.ts,
 * lib/accounting/sources-receipts.ts) and the ledger delta
 * (lib/accounting/derive.ts).
 */
import type { AccountRole } from "./accounts"

/** Signed cents per role: + debit, - credit. A source's vector always sums to zero. */
export type Vector = Partial<Record<AccountRole, number>>

export type EventType =
  | "OPENING"
  | "DISBURSEMENT"
  | "PAYOUT_PAID"
  | "PAYOUT_RETURNED"
  | "DISBURSEMENT_REVERSED"
  | "INSTALMENT_DUE"
  | "DEFAULT_CHARGE"
  | "RECEIPT"
  | "WAIVER"
  | "REVERSAL"
  | "REFUND"
  | "ALLOCATION"
  | "RECLASS"
  | "WRITE_OFF"
  | "ADJUSTMENT"

export interface SourcePayment {
  id: string
  amount: number
  paymentMethod: string
  receivedAt: Date
  allocationStatus: "ALLOCATED" | "UNAPPLIED" | "REFUNDED"
  reconciledAt: Date | null
  reversed: boolean
  reversedAt: Date | null
  /** Set on the refund-due half of a split over-payment. */
  parentPaymentId: string | null
}

export interface SourceLoan {
  id: string
  reference: string
  principal: number
  initiationFee: number
  /** The initiation fee was deducted from the cash advanced (InitiationFeePayment.UPFRONT). */
  upfrontFee: boolean
  startDate: Date
  status: string
  writeOffAt: Date | null
  closedAt: Date | null
  /** When an approved disbursement reversal cancelled the loan (lib/payouts/reversal.ts). */
  reversedAt: Date | null
  schedule: Array<{
    id: string
    installmentNo: number
    dueDate: Date
    interestDue: number
    feesDue: number
    creditLifePremiumDue: number
    totalPaid: number
  }>
  /** `day` is the SAST calendar day as SAST midnight. */
  charges: Array<{ type: string; day: Date; amount: number; sourceId: string | null }>
  payments: SourcePayment[]
  /** Payout attempts (payout channel). None = paid outside the system: the disbursement credits BANK. */
  payouts: Array<{ id: string; attempt: number; amountCents: number; paidAt: Date | null; returnedAt: Date | null }>
}

export interface DesiredSource {
  baseKey: string
  loanId: string
  reference: string
  vector: Vector
  /** Label and date of the source's first posting. */
  origin: { type: EventType; date: Date; description: string }
  /** Label and date of a later correction (a delta after the first posting). */
  change: { type: EventType; date: Date | null; description: string }
  /** Label for a later correction that moves no cash (no BANK line), e.g. an over-payment split. */
  reclass?: { type: EventType; date: Date | null; description: string }
}

export function addTo(vector: Vector, role: AccountRole, cents: number): Vector {
  if (cents !== 0) vector[role] = (vector[role] ?? 0) + cents
  return vector
}

export const before = (date: Date | null, asOf: Date) => date !== null && date.getTime() < asOf.getTime()
