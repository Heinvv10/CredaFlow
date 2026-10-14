/**
 * Payout channels: how a disbursement's money leaves the lender.
 *
 * An adapter only translates to and from its provider's wire format. Every
 * rule about WHEN money may move (one payout per application, claim before
 * send, an unknown outcome is never retried) lives in lib/payouts/dispatch.ts
 * and the database, never in an adapter.
 */

export interface PayoutBeneficiary {
  accountHolder: string
  bankName: string
  branchCode: string
  accountNumber: string
  accountType: string
}

export interface PayoutRequest {
  tenantId: string
  beneficiary: PayoutBeneficiary
  amountCents: number
  /** Shown on the borrower's statement. */
  reference: string
  /** Stable per application ("disburse:<applicationId>"). Sent to providers that accept one. */
  idempotencyKey: string
}

/** Where a payout stands at the provider. */
export type ProviderPayoutState = "SUBMITTED" | "PROCESSING" | "PAID" | "FAILED" | "RETURNED"

/**
 * The outcome of asking a provider to pay.
 *  - accepted: the provider holds the instruction; `state` says how far it got.
 *  - rejected: the provider DEFINITELY did not take the instruction (bad
 *    config, refused before sending). No money can move.
 *  - unknown: anything else (timeout, 5xx, unparseable answer). Money may or
 *    may not move; a person must find out. Never retried automatically.
 */
export type InitiateResult =
  | { kind: "accepted"; state: ProviderPayoutState; providerReference: string; simulated?: true }
  | { kind: "rejected"; reason: string }
  | { kind: "unknown"; reason: string }

export type StatusResult =
  | { kind: "state"; state: ProviderPayoutState; reason?: string }
  | { kind: "unsupported" }
  | { kind: "unknown"; reason: string }

/** A verified result notification from a provider's webhook. */
export interface PayoutNotification {
  providerReference: string | null
  idempotencyKey: string | null
  state: ProviderPayoutState
  reason?: string
}

export interface PayoutProviderCapabilities {
  /** False for the typed skeletons: the registry refuses to dispatch to them. */
  implemented: boolean
  /** The provider can be polled for a payout's state. */
  statusQuery: boolean
  /** The provider posts results to /api/webhooks/payouts/<id>. */
  webhooks: boolean
}

export interface PayoutProvider {
  id: string
  displayName: string
  capabilities: PayoutProviderCapabilities
  initiatePayout(request: PayoutRequest): Promise<InitiateResult>
  getPayoutStatus(args: { tenantId: string; providerReference: string; idempotencyKey: string }): Promise<StatusResult>
  /**
   * Verifies and parses a webhook body. Returns null when the request is not
   * authentic: an unverifiable notification must never move a payout.
   */
  parseWebhook?(args: { rawBody: string; headers: Headers }): PayoutNotification | null
}

export type PayoutProviderErrorCode = "NOT_CONFIGURED" | "UNKNOWN_PROVIDER" | "NOT_IMPLEMENTED" | "INCOMPLETE_BENEFICIARY"

export class PayoutProviderError extends Error {
  constructor(readonly code: PayoutProviderErrorCode, message: string) {
    super(message)
    this.name = "PayoutProviderError"
  }
}
