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
  loanReference: string
  debtor: { firstName: string; lastName: string; idNumber: string; phone: string }
  account: AvsRequest
  amountType: "FIXED" | "VARIABLE" | "USAGE_BASED"
  instalmentAmountCents: number
  maxCollectionAmountCents: number | null
  debitDayOfMonth: number
  authType: MandateAuthType
}

export interface MandateHandle {
  providerMandateRef: string | null
  status: MandateStatusValue
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
}

export interface CollectionOutcome {
  instructionRef: string
  status: "PAID" | "UNPAID" | "DISPUTED" | "PENDING"
  reason: NormalizedReason | null
  rawCode: string | null
  settledAmountCents: number | null
  resolvedAt: Date
}

export interface CollectionProvider {
  readonly id: string
  verifyAccount(req: AvsRequest, creds: ProviderCredentials): Promise<AvsResult>
  createMandate(req: CreateMandateReq, creds: ProviderCredentials): Promise<MandateHandle>
  getMandateStatus(providerMandateRef: string, creds: ProviderCredentials): Promise<MandateStatusValue>
  cancelMandate(providerMandateRef: string, creds: ProviderCredentials): Promise<void>
  collect(batch: CollectionInstructionInput[], creds: ProviderCredentials): Promise<SubmitResult>
  fetchResults(window: { from: Date }, creds: ProviderCredentials): Promise<CollectionOutcome[]>
}

/** Opaque per-tenant credential bag; each adapter documents the keys it reads. */
export type ProviderCredentials = Record<string, string | null | undefined>

/** Subset of TenantConfig the registry needs (keeps registry pure/testable). */
export interface CollectionConfig {
  collectionProvider: string | null
  avsProvider: string | null
}
