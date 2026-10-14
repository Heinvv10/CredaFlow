/**
 * The payout state machine. The database enforces the same table
 * (guardDisbursementPayout); this copy lets code decide before it writes.
 *
 *   PENDING ──claim──> SUBMITTING ──> SUBMITTED ──> PROCESSING ──> PAID ──> RETURNED
 *                          │              │              │
 *                          ├─> PAID / FAILED (definite)  ├─> FAILED / RETURNED
 *                          └─> NEEDS_REVIEW (unknown) ───┴─> NEEDS_REVIEW ──person──> PAID / FAILED
 */
import type { ProviderPayoutState } from "./types"

export const PAYOUT_STATUSES = ["PENDING", "SUBMITTING", "SUBMITTED", "PROCESSING", "PAID", "FAILED", "RETURNED", "NEEDS_REVIEW"] as const
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number]

const ALLOWED: Record<PayoutStatus, readonly PayoutStatus[]> = {
  PENDING: ["SUBMITTING"],
  SUBMITTING: ["SUBMITTED", "PROCESSING", "PAID", "FAILED", "NEEDS_REVIEW"],
  SUBMITTED: ["PROCESSING", "PAID", "FAILED", "RETURNED", "NEEDS_REVIEW"],
  PROCESSING: ["PAID", "FAILED", "RETURNED", "NEEDS_REVIEW"],
  PAID: ["RETURNED"],
  NEEDS_REVIEW: ["PAID", "FAILED"],
  FAILED: [],
  RETURNED: [],
}

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function isSettled(status: PayoutStatus): boolean {
  return status === "PAID" || status === "FAILED" || status === "RETURNED"
}

/**
 * Where a provider-reported state takes a payout, or null to ignore it: a
 * repeat, or a notification older than what is already known (SUBMITTED after
 * PAID). A payout under review is a person's to resolve; a provider's word
 * does not settle it.
 */
export function nextFromProvider(current: PayoutStatus, reported: ProviderPayoutState): PayoutStatus | null {
  if (current === "NEEDS_REVIEW" || current === reported) return null
  return canTransition(current, reported) ? reported : null
}

/** The status right after the provider answered the send. */
export function statusAfterSend(reported: ProviderPayoutState): PayoutStatus {
  // A payout cannot be "returned" by the call that sent it; an answer the
  // machine does not expect is a question for a person.
  return canTransition("SUBMITTING", reported) ? reported : "NEEDS_REVIEW"
}

export const PAYOUT_STATUS_LABELS: Record<PayoutStatus, string> = {
  PENDING: "Waiting to send",
  SUBMITTING: "Sending",
  SUBMITTED: "Submitted to provider",
  PROCESSING: "Processing",
  PAID: "Paid",
  FAILED: "Failed — not paid",
  RETURNED: "Returned by the bank",
  NEEDS_REVIEW: "Needs review — outcome unknown",
}
