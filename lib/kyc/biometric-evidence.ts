import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"

// Minimum face-match and liveness scores (0–100) for payout-grade biometric
// KYC. The provider is the VLM comparing the live selfie against the printed
// ID photograph in one multimodal request (Qwen3-VL-30B spike on real ID
// images): a genuine same-person pair scored 95; a cross-person
// pair scored 10; a borderline same-person pair (years-old ID photo, facial
// hair grown since) scored 10 — i.e. uncertainty fails CLOSED toward the
// in-person verification route, never open. 70 keeps a wide margin above
// every observed impostor/uncertain score while accepting confident matches;
// a client the VLM cannot confidently match retains the human fallback.
export const BIOMETRIC_MATCH_THRESHOLD = 70
export const BIOMETRIC_LIVENESS_THRESHOLD = 70
export const BIOMETRIC_SUBJECT_FINGERPRINT_VERSION = "biometric-subject-v2" as const

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

export type VlmFaceMatchVerdict = {
  faceMatch: boolean
  idPhotoFaceDetected: boolean
  /** 0–100, from the VLM's matchConfidence (0–1). */
  matchScore: number
  /** 0–100, from the VLM's livenessConfidence (0–1). */
  livenessScore: number
}

/**
 * Read the two-image face-match verdict out of a SELFIE extraction result.
 * Returns null — never a partial verdict — unless every field is present and
 * well-formed, so a single-image (legacy) extraction or a malformed VLM
 * response yields no provider evidence and the attempt fails closed.
 */
export function readVlmFaceMatchVerdict(extractionResult: unknown): VlmFaceMatchVerdict | null {
  const extraction = jsonRecord(extractionResult)
  if (!extraction) return null
  const faceMatch = extractedValue(extraction, "faceMatch")
  const idPhotoFaceDetected = extractedValue(extraction, "idPhotoFaceDetected")
  const matchConfidence = extractedValue(extraction, "matchConfidence")
  const livenessConfidence = extractedValue(extraction, "livenessConfidence")
  const isConfidence = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
  if (
    typeof faceMatch !== "boolean"
    || typeof idPhotoFaceDetected !== "boolean"
    || !isConfidence(matchConfidence)
    || !isConfidence(livenessConfidence)
  ) {
    return null
  }
  return {
    faceMatch,
    idPhotoFaceDetected,
    matchScore: Math.round(matchConfidence * 100),
    livenessScore: Math.round(livenessConfidence * 100),
  }
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
  if (providerResult.matchScore < BIOMETRIC_MATCH_THRESHOLD) {
    return { ok: false, reason: "match_score_below_threshold" }
  }
  if (providerResult.livenessScore < BIOMETRIC_LIVENESS_THRESHOLD) {
    return { ok: false, reason: "liveness_score_below_threshold" }
  }
  if (options.requireDocumentVerified !== false && !evidence.verified) {
    return { ok: false, reason: "document_not_verified" }
  }

  return { ok: true }
}
