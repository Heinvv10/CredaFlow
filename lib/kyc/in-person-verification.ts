import {
  adverseFaceVerdict,
  biometricSubjectFingerprint,
  type BiometricEvidenceAssessment,
  type BiometricSubjectClient,
} from "@/lib/kyc/biometric-evidence"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import {
  hasMinimumManualKycExceptionCharacters,
  normalizeManualKycExceptionText,
} from "@/lib/kyc/manual-exception-policy"

/**
 * In-person identity verification — the alternative to a remote biometric.
 *
 * A verified ID document proves a valid document exists. It does NOT prove the
 * applicant is its subject; a borrowed or stolen ID passes a document check.
 * The selfie is what binds the human to the document. Where no selfie can be
 * captured, the only acceptable substitute is a named staff member attesting
 * they compared the person to the ID — so this records that attestation as
 * evidence rather than removing the requirement.
 *
 * A selfie takes this out of scope only while it is a LIVE biometric
 * candidate: an attempt still processing, or one whose provider-verified
 * evidence passed. A failed or soft-deleted attempt does NOT close the human
 * fallback — the senior exception in
 * lib/kyc/manual-exception.ts remains available in parallel for reasoning
 * over the failed evidence itself.
 */
export const IN_PERSON_KYC_VERIFICATION_KIND = "KYC_IN_PERSON_VERIFICATION" as const
export const IN_PERSON_KYC_VERIFICATION_VERSION = "kyc-in-person-verification-v1" as const

/** Minimum characters for the free-text note accompanying the method. */
export const IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS = 20

/**
 * Fixed methods, not free text: a compliance report has to be able to count
 * how many verifications used each route. The note explains the individual
 * case; the method is what makes the population measurable.
 */
export const IN_PERSON_KYC_VERIFICATION_METHODS = [
  "IN_PERSON_BRANCH",
  "KNOWN_EXISTING_CLIENT",
  "AGENT_VERIFIED",
] as const

export type InPersonKycVerificationMethod =
  (typeof IN_PERSON_KYC_VERIFICATION_METHODS)[number]

export const IN_PERSON_KYC_VERIFICATION_METHOD_LABELS: Record<
  InPersonKycVerificationMethod,
  string
> = {
  IN_PERSON_BRANCH: "Verified in person at a branch",
  KNOWN_EXISTING_CLIENT: "Known existing client, identity previously established",
  AGENT_VERIFIED: "Verified in person by a named field agent",
}

const METHODS = new Set<string>(IN_PERSON_KYC_VERIFICATION_METHODS)

export function isInPersonKycVerificationMethod(
  value: unknown,
): value is InPersonKycVerificationMethod {
  return typeof value === "string" && METHODS.has(value)
}

export interface InPersonKycVerificationEvidence {
  kind: typeof IN_PERSON_KYC_VERIFICATION_KIND
  version: typeof IN_PERSON_KYC_VERIFICATION_VERSION
  clientId: string
  /** The exact ID document inspected — replacing it lapses this verification. */
  idDocumentId: string
  idDocumentSha256: string
  subjectFingerprint: string
  method: InPersonKycVerificationMethod
  note: string
  approvedAt: string
  approvedById: string
  approvedByEmail: string
  /** Durable assertion checked by the database when lender policy requires 2FA. */
  approvedWithTotp?: boolean
  /** Present for a dual-control grant and checked against the immutable request. */
  overrideRequestId?: string
}

export interface InPersonKycVerificationRecord {
  id: string
  completedAt: Date | null
  data: unknown
}

/** The ID document this verification is bound to. */
export interface InspectedIdDocument {
  id: string
  contentSha256: string | null
  deletedAt: Date | null
  verified: boolean
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  return normalizeManualKycExceptionText(value) || null
}

export function parseInPersonKycVerificationEvidence(
  value: unknown,
): InPersonKycVerificationEvidence | null {
  const data = jsonRecord(value)
  if (
    !data ||
    data.kind !== IN_PERSON_KYC_VERIFICATION_KIND ||
    data.version !== IN_PERSON_KYC_VERIFICATION_VERSION
  ) {
    return null
  }

  const clientId = nonEmptyString(data.clientId)
  const idDocumentId = nonEmptyString(data.idDocumentId)
  const idDocumentSha256 = nonEmptyString(data.idDocumentSha256)
  const subjectFingerprint = nonEmptyString(data.subjectFingerprint)
  const note = nonEmptyString(data.note)
  const approvedAt = nonEmptyString(data.approvedAt)
  const approvedById = nonEmptyString(data.approvedById)
  const approvedByEmail = nonEmptyString(data.approvedByEmail)
  if (
    !clientId ||
    !idDocumentId ||
    !idDocumentSha256 ||
    !isSha256Digest(idDocumentSha256) ||
    !subjectFingerprint ||
    !isSha256Digest(subjectFingerprint) ||
    !isInPersonKycVerificationMethod(data.method) ||
    !note ||
    !hasMinimumManualKycExceptionCharacters(
      note,
      IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS,
    ) ||
    !approvedAt ||
    !Number.isFinite(Date.parse(approvedAt)) ||
    !approvedById ||
    !approvedByEmail
  ) {
    return null
  }

  return {
    kind: IN_PERSON_KYC_VERIFICATION_KIND,
    version: IN_PERSON_KYC_VERIFICATION_VERSION,
    clientId,
    idDocumentId,
    idDocumentSha256,
    subjectFingerprint,
    method: data.method,
    note,
    approvedAt,
    approvedById,
    approvedByEmail,
  }
}

/**
 * The Prisma where-shape for a selfie that BLOCKS the in-person route: a live
 * biometric candidate — still processing, or provider-verified and passing.
 * Failed and soft-deleted attempts do not block. Together with
 * selfieBlocksInPersonVerification, which releases a passed attempt whose ID
 * copy was rejected or deleted, this MUST stay semantically aligned with the
 * blocking NOT EXISTS in subject_has_in_person_kyc_verification (redefined by
 * migration 20261011060000_face_match_v2_evidence).
 */
export const BLOCKING_SELFIE_CONDITIONS: {
  docType: "SELFIE"
  deletedAt: null
  OR: Array<
    | { extractionStatus: "processing" }
    | { verified: true; biometricVerifiedAt: { not: null } }
  >
} = {
  docType: "SELFIE",
  deletedAt: null,
  OR: [
    { extractionStatus: "processing" },
    { verified: true, biometricVerifiedAt: { not: null } },
  ],
}

/**
 * Whether a selfie matching BLOCKING_SELFIE_CONDITIONS still takes the
 * in-person route out of scope. An attempt still processing always does. A
 * passed one does unless the ID copy it names is no longer a non-deleted,
 * unrejected ID copy of this client (`currentIdCopies`): staff rejected or
 * deleted it, or it is gone. Such a match proves nothing, it no longer counts
 * as biometric evidence, and blocking the human route over it stranded the
 * client until the copy was verified. A passed selfie that names no copy
 * still blocks (fail closed). The ID-portrait refusal closure applies
 * independently.
 *
 * The release holds only for an attestation completed AFTER the selfie was
 * captured (`attestationCompletedAt`), by staff who could see the attempt.
 * Otherwise deleting a doctored copy, or having it rejected, revived an
 * attestation recorded before the episode: VERIFIED with no staff action.
 * Pass the completion time of the attestation being judged, or of the one
 * about to be written; null releases nothing.
 *
 * Mirrors the blocking NOT EXISTS in subject_has_in_person_kyc_verification
 * (migration 20261011060000_face_match_v2_evidence).
 */
export function selfieBlocksInPersonVerification(
  selfie: { extractionStatus: string | null; biometricResult: unknown; createdAt: Date },
  currentIdCopies: readonly {
    id: string
    verificationRejectedAt?: Date | null
    verificationRejectedById?: string | null
  }[],
  attestationCompletedAt: Date | null,
): boolean {
  if (selfie.extractionStatus === "processing") return true
  const namedCopy = jsonRecord(selfie.biometricResult)?.idDocumentId
  if (typeof namedCopy !== "string") return true
  if (attestationCompletedAt === null || attestationCompletedAt.getTime() <= selfie.createdAt.getTime()) {
    return true
  }
  return currentIdCopies.some((copy) =>
    copy.id === namedCopy &&
    (copy.verificationRejectedAt ?? null) === null &&
    (copy.verificationRejectedById ?? null) === null)
}

/**
 * The same predicate, against a row already in memory.
 *
 * A caller holding every selfie for a client — the board loads them in one
 * batch rather than querying per card — still has to ask the question the
 * `where` above asks the database. Written beside the const on purpose: these
 * two and the SQL `NOT EXISTS` in
 * `subject_has_in_person_kyc_verification` are three statements of
 * one rule, and a re-typing of it somewhere else is how they drift apart.
 */
export function matchesBlockingSelfie(row: {
  docType?: string
  deletedAt: Date | null
  extractionStatus: string | null
  verified: boolean
  biometricVerifiedAt: Date | null
}): boolean {
  if (row.docType !== undefined && row.docType !== BLOCKING_SELFIE_CONDITIONS.docType) {
    return false
  }
  if (row.deletedAt !== null) return false
  return (
    row.extractionStatus === "processing"
    || (row.verified && row.biometricVerifiedAt !== null)
  )
}

/**
 * The where-shape for the selfie attempts that can close the in-person route:
 * any attempt, deleted or not, refused as id_document_portrait_invalid.
 * `idDocumentPortraitRefused` then decides which ID copy each one closes.
 */
export const ID_PORTRAIT_REFUSAL_CONDITIONS: {
  docType: "SELFIE"
  OR: [
    { biometricResult: { path: ["biometricFailureReason"]; equals: "id_document_portrait_invalid" } },
    { biometricResult: { path: ["workerFailureReason"]; equals: "id_document_portrait_invalid" } },
  ]
} = {
  docType: "SELFIE",
  // workerFailureReason: the reason the worker gave, kept when the ID/subject
  // binding replaced the recorded one with subject_identity_changed. A refusal
  // of an ID's portrait is a fact about that ID copy and must survive it.
  OR: [
    { biometricResult: { path: ["biometricFailureReason"], equals: "id_document_portrait_invalid" } },
    { biometricResult: { path: ["workerFailureReason"], equals: "id_document_portrait_invalid" } },
  ],
}

const PORTRAIT_INVALID = "id_document_portrait_invalid"

/** Whether a stored result refused the ID portrait, by the recorded or the worker's own reason. */
function refusedIdPortrait(result: Record<string, unknown> | null): result is Record<string, unknown> {
  return result !== null &&
    (result.biometricFailureReason === PORTRAIT_INVALID || result.workerFailureReason === PORTRAIT_INVALID)
}

/** The same predicate, against a row already in memory (the readiness board). */
export function matchesIdPortraitRefusal(row: { docType?: string; biometricResult: unknown }): boolean {
  if (row.docType !== undefined && row.docType !== ID_PORTRAIT_REFUSAL_CONDITIONS.docType) return false
  return refusedIdPortrait(jsonRecord(row.biometricResult))
}

/**
 * Whether ANY selfie attempt (deleted or not, latest or not) was refused
 * because this ID copy has no real photograph on it. While one stands, the
 * in-person route is closed over THIS copy: staff can compare a person to a
 * photo, but not to a silhouette or a blank box, and the reason is
 * deliberately non-exceptionable. A later attempt with any other outcome does
 * not reopen it; only a different ID copy becoming the one attested to does.
 *
 * A refusal closes the route over a copy when it names that copy's
 * idDocumentId, OR that copy's bytes (idDocumentSha256 equal to its
 * contentSha256: the same photo-less image re-uploaded as a new row is the
 * same ID), OR names no copy at all (neither field a string), which closes it
 * over EVERY copy: fail closed. So only a copy with different bytes, under a
 * different row, reopens it.
 *
 * selfie_not_real_photograph does not close it: a person standing at a branch
 * answers a fake selfie, but nothing answers an ID with no photo.
 *
 * Mirrors the NOT EXISTS added to subject_has_in_person_kyc_verification by
 * migration 20261011060000_face_match_v2_evidence. A copy with no digest
 * matches no named digest, as SQL's `=` against NULL does not.
 */
export function idDocumentPortraitRefused(
  attempts: readonly { biometricResult: unknown }[],
  idDocument: { id: string; contentSha256: string | null },
): boolean {
  return attempts.some((attempt) => {
    const result = jsonRecord(attempt.biometricResult)
    if (!refusedIdPortrait(result)) return false
    const namedId = typeof result.idDocumentId === "string" ? result.idDocumentId : null
    const namedSha = typeof result.idDocumentSha256 === "string" ? result.idDocumentSha256 : null
    return (namedId === null && namedSha === null)
      || namedId === idDocument.id
      || (namedSha !== null && namedSha === idDocument.contentSha256)
  })
}

/** biometricResult.verdictRecordedAt: fixed-format ISO, so text order is time order. */
const VERDICT_RECORDED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Whether ANY selfie attempt (deleted or not, latest or not) carries an adverse
 * face verdict recorded after the attestation was completed, against the ID
 * copy the attestation is bound to. Staff attested without seeing that
 * verdict, so it lapses the attestation, and a later benign-failing retake
 * must not bury it. Three things do not count: a verdict recorded strictly
 * before it (staff could see it; the same millisecond cannot be ordered and
 * counts as after), a stale answer naming another ID copy (one naming no copy
 * at all counts: fail closed), and a row without the stamp (written before the
 * stamp existed).
 *
 * `attempts` are the rows of PRIOR_FAILED_ATTEMPT_CONDITIONS: the SQL repeats
 * that status filter. Mirrors the `verdict` NOT EXISTS in
 * subject_has_in_person_kyc_verification (migration
 * 20261014120000_in_person_lapse_on_adverse_verdict).
 */
export function adverseVerdictRecordedAfter(
  attempts: readonly { biometricResult: unknown }[],
  attestationCompletedAt: Date,
  idDocument: { id: string },
): boolean {
  const completedAt = attestationCompletedAt.toISOString()
  return attempts.some((attempt) => {
    const result = jsonRecord(attempt.biometricResult)
    if (!result) return false
    const recordedAt = result.verdictRecordedAt
    if (typeof recordedAt !== "string" || !VERDICT_RECORDED_AT.test(recordedAt)) return false
    if (recordedAt < completedAt) return false
    if (typeof result.idDocumentId === "string" && result.idDocumentId !== idDocument.id) return false
    return adverseFaceVerdict(result)
  })
}

/** The failure reason of an attempt whose outcome was never recorded (swept, or unrecorded). */
const UNKNOWN_OUTCOME_REASON = "biometric_outcome_not_recorded"

/**
 * Whether ANY selfie attempt (deleted or not, latest or not) submitted after
 * the attestation has an unknown outcome. Any of:
 *  - it ended biometric_outcome_not_recorded;
 *  - the sweeper failed it (`sweptAt`, kept when a late answer replaced the
 *    reason);
 *  - it was DELETED while still pending or processing: neither the sweeper nor
 *    the worker's write touches a deleted row, so it never gets a reason, and
 *    it no longer blocks the route either. Its verdict is lost the same way
 *    (biometric-evidence.ts already treats such an attempt as adverse).
 * The lost verdict could have been a mismatch, so it fails closed and lapses
 * the attestation.
 *
 * Mirrors the `unknown_outcome` NOT EXISTS in the same SQL function.
 */
export function unknownOutcomeAfterAttestation(
  attempts: readonly {
    biometricResult: unknown
    createdAt: Date
    deletedAt: Date | null
    extractionStatus: string | null
  }[],
  attestationCompletedAt: Date,
): boolean {
  return attempts.some((attempt) => {
    const result = jsonRecord(attempt.biometricResult)
    // The reason, or the sweeper's lasting marker: a late answer replaces the
    // reason with the real one, but a selfie that was lost and swept stays
    // lost for this rule, whatever arrives later.
    const unknown = result?.biometricFailureReason === UNKNOWN_OUTCOME_REASON ||
      typeof result?.sweptAt === "string" ||
      (attempt.deletedAt instanceof Date &&
        (attempt.extractionStatus === "pending" || attempt.extractionStatus === "processing"))
    return unknown && attempt.createdAt.getTime() >= attestationCompletedAt.getTime()
  })
}

/**
 * The idempotency key of an in-person attestation, shared by the direct route
 * and the dual-approval grant so both agree on what "the same attestation" is.
 *
 * Keyed to the exact circumstances attested to, so one identity + ID pair
 * cannot stack duplicate attestations. The newest selfie attempt is one of
 * them: an attestation from before a later attempt no longer counts once that
 * attempt is released (selfieBlocksInPersonVerification), so staff must be
 * able to attest afresh after it. So is the time its verdict was recorded: an
 * adverse verdict landing after an attestation lapses it
 * (adverseVerdictRecordedAfter), and the fresh attestation over that same
 * attempt must not hit the old key. The stamp is absent on rows written before
 * it existed, so their keys are unchanged.
 */
export function inPersonAttestationIdempotencyKey(args: {
  clientId: string
  idDocument: { id: string; contentSha256: string }
  subjectFingerprint: string
  latestAttempt: { id: string; biometricResult: unknown } | null
}): string {
  const verdictRecordedAt = jsonRecord(args.latestAttempt?.biometricResult)?.verdictRecordedAt
  return [
    "kyc-in-person",
    args.clientId,
    args.idDocument.id,
    args.idDocument.contentSha256,
    args.subjectFingerprint,
    args.latestAttempt?.id ?? "no-selfie",
    ...(typeof verdictRecordedAt === "string" ? [verdictRecordedAt] : []),
  ].join(":")
}

/**
 * Valid only while the exact circumstances the approver attested to still hold.
 *
 * A live biometric attempt — processing or passed — takes this out of scope:
 * the biometric rules govern it. A failed or deleted attempt does not. A
 * replaced ID, an unverified or deleted ID, or an edited identity all lapse
 * it, so this can never become a standing "this client is exempt" flag. So
 * does an adverse face verdict recorded after the attestation, or a selfie
 * attempt submitted after it whose outcome is unknown: the client must be
 * re-verified (a new attestation completed after it, or a selfie that passes).
 */
export function currentInPersonKycVerification(
  record: InPersonKycVerificationRecord | null,
  args: {
    clientId: string
    subject: BiometricSubjectClient
    idDocument: InspectedIdDocument | null
    blockingBiometricAttempt: boolean
    biometricAssessment: BiometricEvidenceAssessment
    /** Selfie attempts matching ID_PORTRAIT_REFUSAL_CONDITIONS. */
    portraitRefusals: readonly { biometricResult: unknown }[]
    /**
     * Every selfie attempt matching PRIOR_FAILED_ATTEMPT_CONDITIONS, deleted
     * or not, with its creation time. Required, not optional: omitting it
     * would silently disable both lapse rules.
     */
    selfieAttempts: readonly {
      biometricResult: unknown
      createdAt: Date
      deletedAt: Date | null
      extractionStatus: string | null
    }[]
  },
): InPersonKycVerificationEvidence | null {
  if (
    !record ||
    !record.completedAt ||
    // A live biometric attempt governs; a failed one does not close this.
    args.blockingBiometricAttempt ||
    args.biometricAssessment.ok ||
    !args.idDocument ||
    args.idDocument.deletedAt !== null ||
    !args.idDocument.verified ||
    // ...except a refusal of this very ID copy's portrait.
    idDocumentPortraitRefused(args.portraitRefusals, args.idDocument)
  ) {
    return null
  }
  const evidence = parseInPersonKycVerificationEvidence(record.data)
  if (!evidence) return null
  if (
    evidence.clientId !== args.clientId ||
    evidence.idDocumentId !== args.idDocument.id ||
    evidence.idDocumentSha256 !== args.idDocument.contentSha256 ||
    evidence.subjectFingerprint !== biometricSubjectFingerprint(args.subject) ||
    evidence.approvedAt !== record.completedAt.toISOString()
  ) {
    return null
  }
  if (
    adverseVerdictRecordedAfter(args.selfieAttempts, record.completedAt, args.idDocument) ||
    unknownOutcomeAfterAttestation(args.selfieAttempts, record.completedAt)
  ) {
    return null
  }
  return evidence
}

/** The evidence half of the in-person route's preconditions, from readCompositeKycState. */
export interface InPersonRouteState {
  /** A selfie still governs: processing, or passed against a current ID copy. */
  blockingBiometricAttempt: boolean
  /** The newest verified ID copy has a usable digest and no portrait refusal. */
  idDocumentAdmissible: boolean
}

/**
 * Whether the KYC tab currently offers the in-person verification form.
 *
 * Two callers, deliberately: the tab itself gates the form on this, and the
 * document upload dialog's selfie step gates its "an ADMIN can record that on
 * the KYC tab" pointer on the same value. Without a shared predicate the
 * pointer promises a control that is not on the page — a selfie step is
 * reachable as soon as the ID copy is extracted, while the form needs EVERY
 * core document. Same shape as `seniorExceptionAvailable`: derived once on the
 * server so no surface can offer an action another surface does not have.
 *
 * Not gated on the viewer's role. A credit officer who cannot grant it still
 * needs to be told the route exists, so they can fetch someone who can.
 *
 * Mirrors the preconditions POST /api/clients/[id]/kyc-in-person-verification
 * checks on the evidence: verified core documents, no manual rejection, no
 * selfie that still governs, an admissible ID copy. It used to follow "a
 * selfie attempt failed", which offered the form over a passed selfie the
 * route then refused, and over incomplete core documents. Two documented
 * differences from the route: an active senior exception hides the form
 * although the route itself would still record an attestation, and the
 * route's idempotency refusal (an identical attestation already on file but
 * no longer current) is not modelled here.
 */
export function inPersonKycVerificationOffered(state: {
  /** A senior exception is already recorded — it supersedes this route. */
  manualExceptionActive: boolean
  /** Already verified in person; the form is replaced by the record of it. */
  inPersonVerificationRecorded: boolean
  /** Every core KYC document is verified. */
  coreDocumentsComplete: boolean
  /** KYC was manually rejected — nothing is offered until that is cleared. */
  manualRejectionActive: boolean
} & InPersonRouteState): boolean {
  return !state.manualExceptionActive &&
    !state.inPersonVerificationRecorded &&
    state.coreDocumentsComplete &&
    !state.manualRejectionActive &&
    !state.blockingBiometricAttempt &&
    state.idDocumentAdmissible
}
