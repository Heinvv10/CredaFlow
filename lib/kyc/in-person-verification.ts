import {
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
 * Failed and soft-deleted attempts do not block. This MUST stay semantically
 * aligned with the NOT EXISTS block in
 * subject_has_in_person_kyc_verification (see
 * the baseline migration).
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
 * Whether the client's latest selfie attempt (deleted or not) was refused
 * because the given ID copy has no real photograph on it. While it stands, the
 * in-person route is closed over THAT copy: staff can compare a person to a
 * photo, but not to a silhouette or a blank box, and the reason is
 * deliberately non-exceptionable. A newer verified ID copy re-opens it. A
 * refusal that names no ID copy is taken to be about this one.
 *
 * selfie_not_real_photograph does not close it: a person standing at a branch
 * answers a fake selfie, but nothing answers an ID with no photo.
 *
 * Mirrors the latest-selfie NOT EXISTS added to
 * subject_has_in_person_kyc_verification by migration
 * 20261011060000_face_match_v2_evidence.
 */
export function latestSelfieRefusedIdDocumentPortrait(
  latestSelfie: { biometricResult: unknown } | null,
  idDocumentId: string,
): boolean {
  const result = jsonRecord(latestSelfie?.biometricResult)
  if (!result || result.biometricFailureReason !== "id_document_portrait_invalid") return false
  return !(typeof result.idDocumentId === "string" && result.idDocumentId !== idDocumentId)
}

/**
 * Valid only while the exact circumstances the approver attested to still hold.
 *
 * A live biometric attempt — processing or passed — takes this out of scope:
 * the biometric rules govern it. A failed or deleted attempt does not. A
 * replaced ID, an unverified or deleted ID, or an edited identity all lapse
 * it, so this can never become a standing "this client is exempt" flag.
 */
export function currentInPersonKycVerification(
  record: InPersonKycVerificationRecord | null,
  args: {
    clientId: string
    subject: BiometricSubjectClient
    idDocument: InspectedIdDocument | null
    blockingBiometricAttempt: boolean
    biometricAssessment: BiometricEvidenceAssessment
    latestSelfie: { biometricResult: unknown } | null
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
    latestSelfieRefusedIdDocumentPortrait(args.latestSelfie, args.idDocument.id)
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
  return evidence
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
 */
export function inPersonKycVerificationOffered(state: {
  /** A senior exception is already recorded — it supersedes this route. */
  manualExceptionActive: boolean
  /** Already verified in person; the form is replaced by the record of it. */
  inPersonVerificationRecorded: boolean
  /** Any selfie attempt exists against the client (failed attempts included). */
  selfieCaptured: boolean
  /** Every core KYC document is uploaded. */
  coreDocumentsComplete: boolean
  /** KYC was manually rejected — nothing is offered until that is cleared. */
  manualRejectionActive: boolean
  /** The composite gate refused the latest biometric attempt. */
  biometricAttemptFailed: boolean
}): boolean {
  if (state.manualExceptionActive || state.inPersonVerificationRecorded) return false
  if (
    !state.selfieCaptured
    && state.coreDocumentsComplete
    && !state.manualRejectionActive
  ) {
    return true
  }
  return state.biometricAttemptFailed
}
