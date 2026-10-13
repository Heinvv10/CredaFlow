import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { faceModelEvidenceRefusal } from "@/lib/kyc/face-model/evidence"

// Minimum face-match and liveness scores (0–100) for payout-grade biometric
// KYC. The provider is the VLM comparing the live selfie against the printed
// ID photograph in one multimodal request. Calibrated on Qwen3-VL-30B: a
// genuine same-person pair scored 95; a cross-person pair scored 10; a
// borderline same-person pair (years-old ID photo, facial hair grown since)
// scored 10 — i.e. uncertainty fails CLOSED toward the in-person verification
// route, never open. 70 keeps a wide margin above every observed
// impostor/uncertain score while accepting confident matches; a client the VLM
// cannot confidently match retains the human fallback. The calibration holds
// for that model only: re-calibrate these thresholds if VLM_MODEL changes.
export const BIOMETRIC_MATCH_THRESHOLD = 70
export const BIOMETRIC_LIVENESS_THRESHOLD = 70
export const BIOMETRIC_SUBJECT_FINGERPRINT_VERSION = "biometric-subject-v2" as const
/**
 * The only provider whose result can verify a selfie. v1 carried a single
 * faceMatch boolean that passed a selfie against a silhouette placeholder
 * (2026-10-10). v2 let the VLM decide same-person, and it said "same" against
 * placeholder cards in 7 of 12 runs; v3 adds the face model's comparison
 * (lib/kyc/face-model/), which alone can confirm the match. Neither v1 nor v2
 * evidence verifies. Mirrored in SQL by subject_has_composite_kyc (migration
 * 20261011080000_face_match_v3_evidence).
 */
export const VLM_FACE_MATCH_PROVIDER = "vlm-face-match-v3" as const

export type BiometricEvidenceFailureReason =
  | "extraction_incomplete"
  | "biometric_evidence_missing"
  | "document_deleted"
  | "document_not_verified"
  | "superseded_biometric_evidence"
  | "subject_fingerprint_missing"
  | "subject_identity_changed"
  | "face_not_detected"
  | "face_count_invalid"
  | "vlm_liveness_failed"
  | "image_unusable"
  | "validation_mismatch"
  | "match_score_below_threshold"
  | "liveness_score_below_threshold"
  | "provider_verification_missing"
  | "simulated_provider_evidence"
  | "provider_verification_failed"
  // The VLM judged the portrait area of the ID document on file not to be a
  // real photograph with a visible face (silhouette, illustration, blank,
  // obscured). There is no face to compare the selfie against, so no human
  // may grant an exception over it: the client must supply a usable ID.
  | "id_document_portrait_invalid"
  // The VLM judged the selfie not to be a camera photograph of a real person.
  // Not exceptionable for the same reason: the remedy is a real selfie.
  | "selfie_not_real_photograph"

const BIOMETRIC_EVIDENCE_FAILURE_REASONS = new Set<BiometricEvidenceFailureReason>([
  "extraction_incomplete",
  "biometric_evidence_missing",
  "document_deleted",
  "document_not_verified",
  "superseded_biometric_evidence",
  "subject_fingerprint_missing",
  "subject_identity_changed",
  "face_not_detected",
  "face_count_invalid",
  "vlm_liveness_failed",
  "image_unusable",
  "validation_mismatch",
  "match_score_below_threshold",
  "liveness_score_below_threshold",
  "provider_verification_missing",
  "simulated_provider_evidence",
  "provider_verification_failed",
  "id_document_portrait_invalid",
  "selfie_not_real_photograph",
])

export function parseBiometricEvidenceFailureReason(
  value: unknown,
): BiometricEvidenceFailureReason | null {
  return typeof value === "string" &&
    BIOMETRIC_EVIDENCE_FAILURE_REASONS.has(value as BiometricEvidenceFailureReason)
    ? value as BiometricEvidenceFailureReason
    : null
}

export type BiometricDocumentEvidence = {
  deletedAt: Date | null
  verified: boolean
  extractionStatus: string
  extractionResult: unknown
  extractionError?: string | null
  validationMismatch: boolean
  validationScore: number | null
  biometricMatchScore: number | null
  biometricLiveness: number | null
  biometricVerifiedAt: Date | null
  biometricResult: unknown
}

export interface BiometricSubjectClient {
  id: string
  idNumber: string
  firstName: string
  lastName: string
  dateOfBirth: Date | null
}

export type BiometricEvidenceAssessment =
  | { ok: true }
  | {
      ok: false
      reason: BiometricEvidenceFailureReason
      /**
       * Set only when the ID-copy binding is the sole refusal: a sound match,
       * bound to this subject, run against a copy that is not (or no longer)
       * the client's newest verified one. Not a failed attempt.
       */
      idDocumentNotCurrent?: true
      /**
       * Set only when the ID-copy binding is the sole refusal, the client has
       * NO verified ID copy, and the copy the match ran against is their
       * CURRENT one (the copy capture would choose now), not yet verified: a
       * first-time borrower who did not wait for staff. Not a failed attempt,
       * and not a pass: the identity check completes once that copy is verified.
       */
      idDocumentAwaitingVerification?: true
    }

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** A raw VLM confidence: finite and within 0..1. */
function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function extractedValue(result: Record<string, unknown>, field: string): unknown {
  const entry = jsonRecord(result[field])
  return entry?.value
}

export type BiometricImageQuality = "good" | "poor" | "unusable"

/**
 * Normalised exactly as subject_has_composite_kyc does: lower(trim(value)),
 * and PostgreSQL's trim() strips spaces only. String.prototype.trim also strips
 * tabs and newlines, so "good\n" passed here and was refused there.
 */
export function parseBiometricImageQuality(value: unknown): BiometricImageQuality | null {
  if (typeof value !== "string") return null
  const normalized = value.replace(/^ +| +$/g, "").toLowerCase()
  return normalized === "good" || normalized === "poor" || normalized === "unusable"
    ? normalized
    : null
}

/**
 * Parse and assess the VLM payload once for both the producer and every
 * downstream KYC gate. Unknown shapes and values fail closed.
 */
export function assessVlmBiometricExtraction(
  extractionResult: unknown,
): BiometricEvidenceAssessment {
  const extraction = jsonRecord(extractionResult)
  if (!extraction) return { ok: false, reason: "biometric_evidence_missing" }
  if (extraction.vlmUnavailable === true) return { ok: true }

  const faceDetected = extractedValue(extraction, "faceDetected")
  const facesCount = extractedValue(extraction, "facesCount")
  const isLive = extractedValue(extraction, "isLive")
  const quality = parseBiometricImageQuality(extractedValue(extraction, "quality"))

  if (
    faceDetected === undefined ||
    facesCount === undefined ||
    isLive === undefined ||
    quality === null
  ) {
    return { ok: false, reason: "biometric_evidence_missing" }
  }
  if (faceDetected !== true) return { ok: false, reason: "face_not_detected" }
  if (typeof facesCount !== "number" || !Number.isInteger(facesCount) || facesCount !== 1) {
    return { ok: false, reason: "face_count_invalid" }
  }
  if (isLive !== true) return { ok: false, reason: "vlm_liveness_failed" }
  if (quality === "unusable") return { ok: false, reason: "image_unusable" }
  return { ok: true }
}

function fingerprintField(value: string): string {
  return Buffer.from(String(value ?? ""), "utf8").toString("hex")
}

/**
 * Hash every exact UTF-8 subject field sent to Smile Identity, including
 * partnerUserId. Each variable field is hex-encoded before joining so the
 * byte representation is unambiguous and reproducible in PostgreSQL.
 *
 * Do not add locale/Unicode case conversion here: JavaScript and PostgreSQL
 * case tables are not byte-for-byte equivalent for valid names such as
 * "Straße". A spelling/case/spacing edit therefore deliberately invalidates
 * prior biometric evidence and requires a new subject-bound attempt.
 */
export function biometricSubjectFingerprint(subject: BiometricSubjectClient): string {
  return createHash("sha256").update([
    BIOMETRIC_SUBJECT_FINGERPRINT_VERSION,
    fingerprintField(subject.id),
    fingerprintField(subject.idNumber),
    fingerprintField(subject.firstName),
    fingerprintField(subject.lastName),
    subject.dateOfBirth?.toISOString().split("T")[0] ?? "",
  ].join(":"), "utf8").digest("hex")
}

/** An ID copy as the selfie gate needs it: which row, and its stored digest. */
export interface BiometricIdDocument {
  id: string
  contentSha256: string | null
}

/** An ID copy with the staff decisions that decide whether a match against it is adverse. */
export interface BiometricIdDocumentCopy extends BiometricIdDocument {
  verified: boolean
  verificationRejectedAt?: Date | null
  verificationRejectedById?: string | null
  createdAt: Date
}

/**
 * The copy capture would compare a selfie against now (CURRENT_ID_DOCUMENT in
 * lib/kyc/usable-id-document.ts): the newest not rejected, createdAt DESC then
 * id DESC. The copies are already the non-deleted ones. Code-unit comparison,
 * as readCompositeKycState breaks the same tie.
 */
function currentIdDocumentCopy(
  copies: readonly BiometricIdDocumentCopy[],
): BiometricIdDocumentCopy | null {
  return copies
    .filter((copy) => (copy.verificationRejectedAt ?? null) === null)
    .reduce<BiometricIdDocumentCopy | null>((newest, copy) => {
      if (newest === null) return copy
      const byCreatedAt = copy.createdAt.getTime() - newest.createdAt.getTime()
      if (byCreatedAt !== 0) return byCreatedAt > 0 ? copy : newest
      return copy.id > newest.id ? copy : newest
    }, null)
}

export function assessBiometricEvidence(
  evidence: BiometricDocumentEvidence,
  options: {
    subject: BiometricSubjectClient
    /**
     * The client's newest verified, non-deleted ID_COPY (createdAt DESC, id
     * DESC), or null if there is none. The selfie must have been compared
     * against exactly this row.
     */
    idDocument: BiometricIdDocument | null
    /**
     * The client's non-deleted ID copies, verified or not, or null when the
     * caller did not read them. Decides only whether an ID-copy binding
     * refusal is a pending ID change (idDocumentNotCurrent): only when the
     * copy the match ran against is a SUPERSEDED VERIFIED copy, i.e. still
     * among them, same digest, never rejected, verified, and not the newest
     * verified one (`idDocument`); or awaits staff verifying that copy
     * (idDocumentAwaitingVerification): only when there is no verified copy
     * and it is the CURRENT copy, same digest, never rejected, and not
     * verified. Anything else leaves the refusal a failed attempt.
     */
    idDocumentCopies: readonly BiometricIdDocumentCopy[] | null
    requireDocumentVerified?: boolean
  },
): BiometricEvidenceAssessment {
  if (evidence.deletedAt !== null) {
    return { ok: false, reason: "document_deleted" }
  }
  if (evidence.extractionStatus !== "done") {
    // The async producer persists its precise terminal failure reason inside
    // biometricResult. Preserve that reason for the staff UI, audit trail and
    // any senior exception review instead of collapsing every completed
    // failure to the generic `extraction_incomplete`. Unknown/untrusted shapes
    // still fail closed to the generic reason.
    const persistedFailure = parseBiometricEvidenceFailureReason(
      jsonRecord(evidence.biometricResult)?.biometricFailureReason,
    )
    if (
      evidence.extractionStatus === "failed" ||
      evidence.extractionStatus === "skipped"
    ) {
      return {
        ok: false,
        reason: persistedFailure ?? "extraction_incomplete",
      }
    }
    return { ok: false, reason: "extraction_incomplete" }
  }

  const vlmAssessment = assessVlmBiometricExtraction(evidence.extractionResult)
  if (!vlmAssessment.ok) return vlmAssessment

  if (evidence.validationMismatch) {
    return { ok: false, reason: "validation_mismatch" }
  }
  if (
    typeof evidence.validationScore !== "number" ||
    typeof evidence.biometricMatchScore !== "number" ||
    typeof evidence.biometricLiveness !== "number"
  ) {
    return { ok: false, reason: "biometric_evidence_missing" }
  }
  if (
    evidence.validationScore < BIOMETRIC_MATCH_THRESHOLD ||
    evidence.biometricMatchScore < BIOMETRIC_MATCH_THRESHOLD
  ) {
    return { ok: false, reason: "match_score_below_threshold" }
  }
  if (evidence.biometricLiveness < BIOMETRIC_LIVENESS_THRESHOLD) {
    return { ok: false, reason: "liveness_score_below_threshold" }
  }
  if (!evidence.biometricVerifiedAt) {
    return { ok: false, reason: "provider_verification_missing" }
  }

  const providerResult = jsonRecord(evidence.biometricResult)
  if (!providerResult) {
    return { ok: false, reason: "provider_verification_missing" }
  }
  // Absent or exactly false only: subject_has_composite_kyc refused the string
  // "true" that this let through.
  if (providerResult.simulated !== undefined && providerResult.simulated !== false) {
    return { ok: false, reason: "simulated_provider_evidence" }
  }
  if (
    typeof providerResult.subjectFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(providerResult.subjectFingerprint)
  ) {
    return { ok: false, reason: "subject_fingerprint_missing" }
  }
  if (providerResult.subjectFingerprint !== biometricSubjectFingerprint(options.subject)) {
    return { ok: false, reason: "subject_identity_changed" }
  }
  if (
    providerResult.ok !== true ||
    providerResult.verified !== true ||
    typeof providerResult.matchScore !== "number" ||
    typeof providerResult.livenessScore !== "number"
  ) {
    return { ok: false, reason: "provider_verification_failed" }
  }
  // Passing evidence is always the v3 verdict. The VLM-unavailable marker
  // stands in for the extraction checks only (assessVlmBiometricExtraction);
  // it does not exempt the provider result, and with the VLM unavailable the
  // producer writes none at all.
  if (providerResult.provider !== VLM_FACE_MATCH_PROVIDER) {
    // No v3 check stands behind these scores (v1, v2, untagged or unknown).
    return { ok: false, reason: "provider_verification_missing" }
  }
  if (
    providerResult.idPhotoKind !== "photograph" ||
    providerResult.idPhotoIsRealPhotograph !== true ||
    providerResult.idPhotoFaceDetected !== true ||
    providerResult.selfieIsRealPhotograph !== true ||
    providerResult.samePerson !== "same" ||
    providerResult.faceMatch !== true ||
    !isConfidence(providerResult.matchConfidence) ||
    !isConfidence(providerResult.livenessConfidence)
  ) {
    // `verified: true` alongside a judgement that refuses is not a pass.
    return { ok: false, reason: "provider_verification_failed" }
  }
  // Rounded score AND raw confidence: 0.695 rounds to a passing 70.
  const { matchScore, matchConfidence, livenessScore, livenessConfidence } = providerResult
  if (matchScore < BIOMETRIC_MATCH_THRESHOLD || matchConfidence < BIOMETRIC_MATCH_THRESHOLD / 100) {
    return { ok: false, reason: "match_score_below_threshold" }
  }
  if (livenessScore < BIOMETRIC_LIVENESS_THRESHOLD || livenessConfidence < BIOMETRIC_LIVENESS_THRESHOLD / 100) {
    return { ok: false, reason: "liveness_score_below_threshold" }
  }
  // The same-person decision is the face model's; the VLM's "same" above can
  // only have refused. Its stored fields must re-prove the pass.
  const faceModelRefusal = faceModelEvidenceRefusal(providerResult.faceModel)
  if (faceModelRefusal) return { ok: false, reason: faceModelRefusal }
  if (options.requireDocumentVerified !== false && !evidence.verified) {
    return { ok: false, reason: "document_not_verified" }
  }
  // A match against any other ID copy (a newer unverified or rejected upload,
  // or one since replaced) says nothing about the verified identity. Checked
  // last, so that refusing here means every other check passed. Two ID
  // states are not a failed attempt. A superseded verified copy: staff
  // verified a new copy after a match against the copy they had verified
  // before; deriveCompositeKycState projects it as pending. The client's
  // first ID copy, not yet verified: a borrower who did not wait for staff;
  // pending with origination BLOCKED until staff verify it. A match against
  // an unverified copy while a verified one is on file stays a failure: it is
  // indistinguishable from a doctored substitute uploaded after a face
  // mismatch against the verified ID. So does one against a copy since
  // rejected, deleted, rewritten or buried under a later upload, or not this
  // client's.
  if (
    !options.idDocument ||
    !isSha256Digest(options.idDocument.contentSha256) ||
    providerResult.idDocumentId !== options.idDocument.id ||
    providerResult.idDocumentSha256 !== options.idDocument.contentSha256
  ) {
    const boundCopy = options.idDocumentCopies?.find((copy) => copy.id === providerResult.idDocumentId)
    // Superseded: the copies' newest verified one is `idDocument`, so a
    // verified copy that is not it sorts after it (createdAt DESC, id DESC).
    const pendingIdChange = boundCopy !== undefined &&
      isSha256Digest(boundCopy.contentSha256) &&
      boundCopy.contentSha256 === providerResult.idDocumentSha256 &&
      (boundCopy.verificationRejectedAt ?? null) === null &&
      (boundCopy.verificationRejectedById ?? null) === null &&
      boundCopy.verified &&
      options.idDocument !== null &&
      boundCopy.id !== options.idDocument.id
    if (pendingIdChange) {
      return { ok: false, reason: "subject_identity_changed", idDocumentNotCurrent: true }
    }
    const awaitingVerification = options.idDocument === null &&
      boundCopy !== undefined &&
      options.idDocumentCopies !== null &&
      currentIdDocumentCopy(options.idDocumentCopies)?.id === boundCopy.id &&
      isSha256Digest(boundCopy.contentSha256) &&
      boundCopy.contentSha256 === providerResult.idDocumentSha256 &&
      (boundCopy.verificationRejectedById ?? null) === null &&
      !boundCopy.verified
    return awaitingVerification
      ? { ok: false, reason: "subject_identity_changed", idDocumentAwaitingVerification: true }
      : { ok: false, reason: "subject_identity_changed" }
  }

  return { ok: true }
}
