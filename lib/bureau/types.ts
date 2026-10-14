/**
 * Provider-agnostic credit bureau ENQUIRY abstraction.
 * No bureau-specific names, codes or fields may appear in this file: each
 * adapter under lib/bureau/providers/ translates its own wire format into
 * these types. (Bureau DATA SUBMISSION is lib/bureau-submission — separate.)
 */

/** Why the lender is asking. Recorded at the bureau and visible in the
 *  consumer's enquiry history, so it is chosen per call, never defaulted. */
export type BureauPurpose =
  | "AFFORDABILITY_ASSESSMENT"
  | "CREDIT_ASSESSMENT"
  | "ACCOUNT_MANAGEMENT"
  | "DEBT_COLLECTION"
  | "FRAUD_PREVENTION"

export interface BureauConsumer {
  /** South African ID number. */
  idNumber: string
  firstName: string
  lastName: string
  gender: "M" | "F" | null
  dateOfBirth: Date | null
}

/** The consumer's consent to this enquiry. A request cannot be built without
 *  one: the reference names the consent record the lender relied on. */
export interface BureauConsent {
  reference: string
}

export interface BureauEnquiryRequest {
  tenantId: string
  consumer: BureauConsumer
  purpose: BureauPurpose
  consent: BureauConsent
  /** Our reference for the enquiry (the application id); echoed where the bureau supports it. */
  reference: string
}

export interface ScoreBand {
  min: number
  max: number
}

export interface BureauScore {
  /** Null when the bureau could not score the consumer. */
  value: number | null
  /** The scale `value` is on; null when the bureau's scale is not documented.
   *  Scores from different bands are not comparable. */
  band: ScoreBand | null
  /** The bureau's own risk label for the score, verbatim. */
  riskGrade: string | null
  unscoreable: boolean
  declineReasons: string[]
}

/** One credit account (tradeline) on the report. */
export interface BureauTradeline {
  subscriber: string
  accountType: string | null
  /** Monthly instalment in cents. */
  instalmentCents: number
  /** The bureau's status text, verbatim. */
  status: string | null
  /** Whether the account is open and paying. Null when the adapter cannot
   *  tell; affordability counts an unknown account as open. */
  open: boolean | null
}

/**
 * The normalised report. A field the bureau does not supply is null, never
 * false or zero: "not reported" and "reported as none" are different facts.
 */
export interface BureauReport {
  provider: string
  /** Fabricated by a simulator or a dry-run, never valid evidence where simulation is forbidden. */
  simulated: boolean
  /** The simulation-guard key whose policy governs this report when simulated. */
  simulationSource: string | null
  score: BureauScore | null
  deceased: boolean | null
  underDebtReview: boolean | null
  hasJudgement: boolean | null
  /** Notices such as sequestration or administration. */
  hasNotice: boolean | null
  /** Adverse listings / defaults, as the bureau describes them. */
  defaults: string[]
  enquiriesLast90Days: number | null
  pepIndicator: boolean | null
  fraudIndicator: boolean | null
  tradelines: BureauTradeline[]
  /** The bureau's own monthly-instalment total, in cents, when it states one. */
  statedMonthlyInstalmentCents: number | null
  /** SHA-256 of the raw response body, so a later archived payload can be matched. */
  rawSha256: string | null
}

export interface BureauCapabilities {
  score: ScoreBand | null
  tradelines: boolean
  judgements: boolean
  defaults: boolean
  enquiryCount: boolean
  pep: boolean
  fraud: boolean
  /** False while the adapter is a skeleton awaiting the bureau's specification. */
  implemented: boolean
}

export type BureauProviderErrorCode =
  | "UNKNOWN_PROVIDER"
  | "NOT_CONFIGURED"
  | "NOT_IMPLEMENTED"
  | "TIMEOUT"
  | "SIMULATION_FORBIDDEN"
  | "PROVIDER_ERROR"
  /** The bureau refused because of the consumer or our request (bad ID,
   *  minor, no consent). Another bureau would refuse it too. */
  | "SUBJECT_REJECTED"

export class BureauProviderError extends Error {
  constructor(
    public readonly code: BureauProviderErrorCode,
    message: string,
    /** The bureau's own error code and class, for the compliance record. */
    public readonly detail: { providerCode?: string; errorClass?: string } = {},
  ) {
    super(message)
    this.name = "BureauProviderError"
  }
}

/** Per-tenant credential bag for one provider; each adapter documents its keys. */
export type BureauCredentials = Record<string, string>

export interface BureauEnquiryContext {
  credentials: BureauCredentials | null
  signal: AbortSignal
}

export interface BureauProvider {
  readonly id: string
  readonly displayName: string
  readonly capabilities: BureauCapabilities
  /** Credential keys the adapter reads from its bag. */
  readonly credentialFields: readonly string[]
  /** Resolves a report, or throws BureauProviderError. */
  enquiry(request: BureauEnquiryRequest, context: BureauEnquiryContext): Promise<BureauReport>
}

export type BureauAttemptStatus =
  | "OK"
  | "FAILED"
  | "TIMEOUT"
  | "NOT_CONFIGURED"
  | "NOT_IMPLEMENTED"
  | "UNKNOWN_PROVIDER"
  | "SIMULATION_FORBIDDEN"
  | "SUBJECT_REJECTED"

export type BureauAttempt =
  | { attempt: number; provider: string; status: "OK"; report: BureauReport }
  | {
      attempt: number
      provider: string
      status: Exclude<BureauAttemptStatus, "OK">
      error: string
      providerCode: string | null
      errorClass: string | null
    }
