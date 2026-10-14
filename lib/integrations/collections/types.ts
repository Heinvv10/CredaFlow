// lib/integrations/collections/types.ts
/**
 * Provider-agnostic collection abstraction.
 * No provider-specific names/fields may appear in this file.
 */

export type NormalizedReason =
  | "INSUFFICIENT_FUNDS"
  | "ACCOUNT_CLOSED"
  | "PAYMENT_STOPPED"
  | "MANDATE_SUSPENDED"
  | "MANDATE_CANCELLED"
  | "ACCOUNT_FROZEN"
  | "NO_DEBIT_FACILITY"
  | "NOT_FICA"
  | "UNKNOWN"

export type CollectionProviderErrorCode =
  | "UNKNOWN_PROVIDER"
  | "NOT_CONFIGURED"
  | "NOT_IMPLEMENTED"
  | "PROVIDER_ERROR"

export class CollectionProviderError extends Error {
  constructor(
    public readonly code: CollectionProviderErrorCode,
    message: string
  ) {
    super(message)
    this.name = "CollectionProviderError"
  }
}

export interface AvsRequest {
  accountHolder: string
  idNumber: string
  bankName: string
  branchCode: string
  accountNumber: string
  accountType: "CHEQUE" | "SAVINGS"
}

/** null = the provider did not return this check. */
export interface AvsChecks {
  accountActive: boolean | null
  acceptsDebits: boolean | null
  idNumberMatch: boolean | null
  lastNameMatch: boolean | null
  openThreeMonths: boolean | null
}

export interface AvsResult {
  passed: boolean
  /** Synthetic provider response. Never valid account-verification evidence. */
  simulated?: true
  checks: AvsChecks
  raw: unknown
}

export type MandateAuthType = "TT1" | "TT1_DELAYED" | "TT2"

export type MandateStatusValue =
  | "PENDING_AUTH"
  | "AUTHENTICATED"
  | "REJECTED"
  | "EXPIRED"
  | "SUSPENDED"
  | "CANCELLED"

export interface CreateMandateReq {
  /** The engine's own mandate id: adapters pass it as the contract reference so a retried submission is idempotent. */
  mandateReference: string
  loanReference: string
  debtor: { firstName: string; lastName: string; idNumber: string; phone: string }
  account: AvsRequest
  amountType: "FIXED" | "VARIABLE" | "USAGE_BASED"
  instalmentAmountCents: number
  maxCollectionAmountCents: number | null
  debitDayOfMonth: number
  authType: MandateAuthType
  frequency: "ONCE_OFF" | "MONTHLY"
  firstCollectionDate: Date
  /** Bank-level auto-re-presentment window, 1–10 days (scheme rule). */
  trackingDays: number
  adjustment: "NEVER" | "QUARTERLY" | "BIANNUALLY" | "ANNUALLY" | "REPO_RATE"
}

export interface MandateHandle {
  providerMandateRef: string | null
  status: MandateStatusValue
  /** Synthetic provider response: no bank saw this mandate. */
  simulated?: true
}

export interface CollectionInstructionInput {
  mandateRef: string
  amountCents: number
  actionDate: Date
  /** Bank-level auto-re-presentment window, 1–10 days (scheme rule). */
  trackingDays: number
  instructionRef: string
}

export interface SubmitResult {
  batchRef: string
  accepted: string[]
  rejected: { instructionRef: string; error: string }[]
  /** Synthetic provider response: nothing was sent to a bank. */
  simulated?: true
}

/**
 * An instruction the engine is still waiting on. Adapters whose rail reports
 * by date window may ignore it; adapters that query per batch or per item
 * (and the simulator) use it.
 */
export interface AwaitingInstruction {
  instructionRef: string
  mandateRef: string
  batchRef: string | null
  amountCents: number
  actionDate: Date
}

export interface CollectionOutcome {
  instructionRef: string
  status: "PAID" | "UNPAID" | "DISPUTED" | "PENDING"
  reason: NormalizedReason | null
  rawCode: string | null
  settledAmountCents: number | null
  resolvedAt: Date
  /** The provider's record as received, persisted for audit. */
  raw?: unknown
  /** Synthetic provider outcome: no money moved. */
  simulated?: true
}

export interface CollectionProvider {
  readonly id: string
  verifyAccount(req: AvsRequest, creds: ProviderCredentials): Promise<AvsResult>
  createMandate(req: CreateMandateReq, creds: ProviderCredentials): Promise<MandateHandle>
  getMandateStatus(providerMandateRef: string, creds: ProviderCredentials): Promise<MandateStatusValue>
  cancelMandate(providerMandateRef: string, creds: ProviderCredentials): Promise<void>
  collect(batch: CollectionInstructionInput[], creds: ProviderCredentials): Promise<SubmitResult>
  fetchResults(window: { from: Date; awaiting?: AwaitingInstruction[] }, creds: ProviderCredentials): Promise<CollectionOutcome[]>
}

/** Opaque per-tenant credential bag; each adapter documents the keys it reads. */
export type ProviderCredentials = Record<string, string | null | undefined>

/** Subset of TenantConfig the registry needs (keeps registry pure/testable). */
export interface CollectionConfig {
  collectionProvider: string | null
  avsProvider: string | null
}
