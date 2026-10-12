import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"

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
 * (2026-10-10), so v1 evidence never verifies. Mirrored in SQL by
 * subject_has_composite_kyc (migration 20261011060000_face_match_v2_evidence).
 */
export const VLM_FACE_MATCH_PROVIDER = "vlm-face-match-v2" as const

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
  | { ok: false; reason: BiometricEvidenceFailureReason }

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

export function parseBiometricImageQuality(value: unknown): BiometricImageQuality | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
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

export function assessBiometricEvidence(
  evidence: BiometricDocumentEvidence,
  options: {
    subject: BiometricSubjectClient
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
  if (providerResult.simulated === true) {
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
  // The VLM is the only provider, so passing evidence is always the v2
  // verdict. The VLM-unavailable marker stands in for the extraction checks
  // only (assessVlmBiometricExtraction); it does not exempt the provider
  // result, and with the VLM unavailable the producer writes none at all.
  if (providerResult.provider !== VLM_FACE_MATCH_PROVIDER) {
    // No v2 check stands behind these scores (v1, untagged or unknown).
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
  if (options.requireDocumentVerified !== false && !evidence.verified) {
    return { ok: false, reason: "document_not_verified" }
  }

  return { ok: true }
}
