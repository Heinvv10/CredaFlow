/**
 * Ledger reconciliation for loans paid outside the application.
 *
 * The money left the bank; the application never reached DISBURSED. This is the
 * only sanctioned way to book such a loan, and it is deliberately a closed
 * allow-list: an application is reconcilable only if it is named here AND the DB
 * validator agrees (see validOutageDisbursementExceptionValues and
 * guardLoanApplicationOutageExceptionBinding in the baseline migration).
 *
 * THE ALLOW-LIST IS INTENTIONALLY EMPTY IN THIS PRODUCT, here and in the DB
 * functions. The mechanism and every refusal path stay; nothing is reconcilable
 * through it, so every incident id and every application is refused.
 *
 * COHORTS ARE PER INCIDENT. Reconciliation is all-or-nothing across an
 * incident's applications, so a new incident must never widen the cohort of an
 * incident already reconciled: that would trip the partial-state guard and, in
 * the worst case, rewrite a live loan.
 */
export const OUTAGE_EXCEPTION_KIND = "DISBURSEMENT_OUTAGE_EXCEPTION" as const
export const OUTAGE_EXCEPTION_VERSION =
  "disbursement-outage-exception-v1" as const

export type OutageWaivedPrecondition =
  | "signed_agreement"
  | "provider_countersign"
  | "acknowledged_pasq"
  | "composite_kyc"
  | "verified_banking"

export interface OutageApplicationPolicy {
  applicationId: string
  reference: string
  incidentId: string
  payoutDate: string
  managementApprovedBy: string
  principalCents: number
  termDays: number
  interestRatePm: number
  repaymentMethod: "EFT"
  creditLifeElection: "DECLINED"
  /** What the bank recorded as the payment reference; the DB pins it exactly. */
  disbursementRef: string
  /** CONTRACT when an agreement was generated, otherwise APPROVAL. */
  calculatorSource: "CONTRACT" | "APPROVAL"
  expectedPayoutProfile: {
    bankName: string
    branchCode: string
    accountType: string
  }
  waivedPreconditions: readonly OutageWaivedPrecondition[]
}

export const OUTAGE_APPLICATIONS: Readonly<
  Record<string, OutageApplicationPolicy>
> = {}

export type OutageApplicationId = keyof typeof OUTAGE_APPLICATIONS
export type OutageIncidentId = OutageApplicationPolicy["incidentId"]

export interface DisbursementOutageExceptionEvidence {
  kind: typeof OUTAGE_EXCEPTION_KIND
  version: typeof OUTAGE_EXCEPTION_VERSION
  incidentId: OutageIncidentId
  applicationId: OutageApplicationId
  applicationReference: OutageApplicationPolicy["reference"]
  actualPayoutDate: OutageApplicationPolicy["payoutDate"]
  timestampPrecision: "DATE"
  managementApprovedBy: OutageApplicationPolicy["managementApprovedBy"]
  managementApprovalNote: string
  waivedPreconditions: readonly OutageWaivedPrecondition[]
  reconciledById: string
  reconciledByEmail: string
  reconciledAt: string
  duplicatePayoutSuppressed: true
}

const MIN_APPROVAL_NOTE_CHARACTERS = 20

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactStrings(
  value: unknown,
  expected: readonly string[],
): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index])
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
}

export function outageApplicationPolicy(
  applicationId: string,
): OutageApplicationPolicy | null {
  if (!Object.hasOwn(OUTAGE_APPLICATIONS, applicationId)) return null
  return OUTAGE_APPLICATIONS[applicationId as OutageApplicationId]
}

/**
 * The disbursementRef written onto a reconciled application, per incident.
 *
 * The DB trigger pins this string exactly, so it must be derived the same way on
 * both sides. It was a single literal while there was one incident.
 */
export function outageDisbursementRef(
  source: { disbursementRef: OutageApplicationPolicy["disbursementRef"] },
): string {
  return source.disbursementRef
}

/** Every incident with at least one reconcilable application, sorted. */
export function outageIncidentIds(): OutageIncidentId[] {
  return [
    ...new Set(
      Object.values(OUTAGE_APPLICATIONS).map((policy) => policy.incidentId),
    ),
  ].sort()
}

export function isOutageIncidentId(value: string): value is OutageIncidentId {
  return (outageIncidentIds() as readonly string[]).includes(value)
}

/**
 * The applications belonging to ONE incident, sorted.
 *
 * Reconciliation is all-or-nothing across whatever this returns, so scoping it
 * by incident is what keeps a new incident from re-opening a settled one.
 */
export function outageApplicationIdsForIncident(
  incidentId: string,
): OutageApplicationId[] {
  return (Object.keys(OUTAGE_APPLICATIONS) as OutageApplicationId[])
    .filter((id) => OUTAGE_APPLICATIONS[id].incidentId === incidentId)
    .sort()
}

/**
 * The bank processing time is unavailable. Noon SAST is a date-only storage
 * normalization, not a claim about the exact processing time.
 *
 * Accepts only a payout date some policy actually declares, so an arbitrary date
 * can never be normalized into a disbursement timestamp.
 */
export function normalizeSastDateOnly(value: string): Date {
  const approved = new Set<string>(
    Object.values(OUTAGE_APPLICATIONS).map((policy) => policy.payoutDate),
  )
  if (!approved.has(value)) {
    throw new Error("Only an approved outage payout date may be normalized")
  }
  return new Date(`${value}T12:00:00.000+02:00`)
}

export function createOutageExceptionEvidence(args: {
  applicationId: OutageApplicationId
  applicationReference: string
  managementApprovalNote: string
  reconciledById: string
  reconciledByEmail: string
  reconciledAt: Date
}): DisbursementOutageExceptionEvidence {
  const policy = outageApplicationPolicy(args.applicationId)
  if (!policy || policy.reference !== args.applicationReference) {
    throw new Error("The application reference does not match the outage policy")
  }
  const managementApprovalNote = normalizedText(args.managementApprovalNote)
  if (managementApprovalNote.length < MIN_APPROVAL_NOTE_CHARACTERS) {
    throw new Error(
      `The management approval note must contain at least ${MIN_APPROVAL_NOTE_CHARACTERS} characters`,
    )
  }
  const reconciledById = normalizedText(args.reconciledById)
  const reconciledByEmail = normalizedText(args.reconciledByEmail).toLowerCase()
  if (!reconciledById || !reconciledByEmail || !Number.isFinite(args.reconciledAt.getTime())) {
    throw new Error("The authenticated reconciliation operator is incomplete")
  }

  return {
    kind: OUTAGE_EXCEPTION_KIND,
    version: OUTAGE_EXCEPTION_VERSION,
    incidentId: policy.incidentId,
    applicationId: args.applicationId,
    applicationReference: policy.reference,
    actualPayoutDate: policy.payoutDate,
    timestampPrecision: "DATE",
    managementApprovedBy: policy.managementApprovedBy,
    managementApprovalNote,
    waivedPreconditions: [...policy.waivedPreconditions],
    reconciledById,
    reconciledByEmail,
    reconciledAt: args.reconciledAt.toISOString(),
    duplicatePayoutSuppressed: true,
  }
}

export function parseOutageExceptionEvidence(
  value: unknown,
): DisbursementOutageExceptionEvidence | null {
  if (
    !isRecord(value)
    || value.kind !== OUTAGE_EXCEPTION_KIND
    || value.version !== OUTAGE_EXCEPTION_VERSION
    || typeof value.applicationId !== "string"
  ) {
    return null
  }
  const policy = outageApplicationPolicy(value.applicationId)
  if (
    !policy
    // Read from the policy, never from the payload: a stored row claiming a
    // different incident or payout date than its application's policy is not
    // evidence, it is a mismatch.
    || value.incidentId !== policy.incidentId
    || value.applicationReference !== policy.reference
    || value.actualPayoutDate !== policy.payoutDate
    || value.timestampPrecision !== "DATE"
    || value.managementApprovedBy !== policy.managementApprovedBy
    || typeof value.managementApprovalNote !== "string"
    || normalizedText(value.managementApprovalNote).length
      < MIN_APPROVAL_NOTE_CHARACTERS
    || !exactStrings(value.waivedPreconditions, policy.waivedPreconditions)
    || typeof value.reconciledById !== "string"
    || normalizedText(value.reconciledById).length === 0
    || typeof value.reconciledByEmail !== "string"
    || normalizedText(value.reconciledByEmail).length === 0
    || !isIsoInstant(value.reconciledAt)
    || value.duplicatePayoutSuppressed !== true
  ) {
    return null
  }
  return value as unknown as DisbursementOutageExceptionEvidence
}
