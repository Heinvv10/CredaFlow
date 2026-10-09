import {
  biometricSubjectFingerprint,
  parseBiometricEvidenceFailureReason,
  type BiometricEvidenceAssessment,
  type BiometricEvidenceFailureReason,
  type BiometricSubjectClient,
} from "@/lib/kyc/biometric-evidence"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import {
  MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS,
  MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS,
  hasMinimumManualKycExceptionCharacters,
  isManualKycExceptionableAttempt,
  isManualKycExceptionableFailureReason,
  normalizeManualKycExceptionText,
} from "@/lib/kyc/manual-exception-policy"

export const MANUAL_KYC_EXCEPTION_KIND = "KYC_MANUAL_EXCEPTION" as const
export const MANUAL_KYC_EXCEPTION_VERSION = "manual-kyc-exception-v1" as const

export interface ManualKycExceptionEvidence {
  kind: typeof MANUAL_KYC_EXCEPTION_KIND
  version: typeof MANUAL_KYC_EXCEPTION_VERSION
  clientId: string
  documentId: string
  documentSha256: string
  subjectFingerprint: string
  biometricFailureReason: BiometricEvidenceFailureReason
  reason: string
  supportingEvidence: string
  approvedAt: string
  approvedById: string
  approvedByEmail: string
}

export interface ManualKycExceptionRecord {
  id: string
  completedAt: Date | null
  data: unknown
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = normalizeManualKycExceptionText(value)
  return normalized || null
}

export function parseManualKycExceptionEvidence(
  value: unknown,
): ManualKycExceptionEvidence | null {
  const data = jsonRecord(value)
  if (
    !data ||
    data.kind !== MANUAL_KYC_EXCEPTION_KIND ||
    data.version !== MANUAL_KYC_EXCEPTION_VERSION
  ) {
    return null
  }

  const clientId = nonEmptyString(data.clientId)
  const documentId = nonEmptyString(data.documentId)
  const documentSha256 = nonEmptyString(data.documentSha256)
  const subjectFingerprint = nonEmptyString(data.subjectFingerprint)
  const biometricFailureReason = parseBiometricEvidenceFailureReason(
    data.biometricFailureReason,
  )
  const reason = nonEmptyString(data.reason)
  const supportingEvidence = nonEmptyString(data.supportingEvidence)
  const approvedAt = nonEmptyString(data.approvedAt)
  const approvedById = nonEmptyString(data.approvedById)
  const approvedByEmail = nonEmptyString(data.approvedByEmail)
  if (
    !clientId ||
    !documentId ||
    !documentSha256 ||
    !isSha256Digest(documentSha256) ||
    !subjectFingerprint ||
    !isSha256Digest(subjectFingerprint) ||
    !biometricFailureReason ||
    !isManualKycExceptionableFailureReason(biometricFailureReason) ||
    !reason ||
    !hasMinimumManualKycExceptionCharacters(
      reason,
      MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS,
    ) ||
    !supportingEvidence ||
    !hasMinimumManualKycExceptionCharacters(
      supportingEvidence,
      MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS,
    ) ||
    !approvedAt ||
    !Number.isFinite(Date.parse(approvedAt)) ||
    !approvedById ||
    !approvedByEmail
  ) {
    return null
  }

  return {
    kind: MANUAL_KYC_EXCEPTION_KIND,
    version: MANUAL_KYC_EXCEPTION_VERSION,
    clientId,
    documentId,
    documentSha256,
    subjectFingerprint,
    biometricFailureReason,
    reason,
    supportingEvidence,
    approvedAt,
    approvedById,
    approvedByEmail,
  }
}

/**
 * A manual exception is not a biometric pass. It is a senior, immutable
 * acceptance of one exact failed attempt for one exact identity. Any new
 * selfie, identity edit, deleted bytes, changed digest or different failure
 * reason invalidates it automatically.
 */
export function currentManualKycException(
  record: ManualKycExceptionRecord | null,
  args: {
    clientId: string
    subject: BiometricSubjectClient
    latestSelfie: {
      id: string
      deletedAt: Date | null
      contentSha256: string | null
      extractionStatus: string
    } | null
    biometricAssessment: BiometricEvidenceAssessment
  },
): ManualKycExceptionEvidence | null {
  if (
    !record ||
    !record.completedAt ||
    !args.latestSelfie ||
    args.latestSelfie.deletedAt !== null ||
    args.biometricAssessment.ok ||
    !isManualKycExceptionableAttempt({
      extractionStatus: args.latestSelfie.extractionStatus,
      biometricFailureReason: args.biometricAssessment.reason,
    })
  ) {
    return null
  }
  const evidence = parseManualKycExceptionEvidence(record.data)
  if (!evidence) return null
  if (
    evidence.clientId !== args.clientId ||
    evidence.documentId !== args.latestSelfie.id ||
    evidence.documentSha256 !== args.latestSelfie.contentSha256 ||
    evidence.subjectFingerprint !== biometricSubjectFingerprint(args.subject) ||
    evidence.biometricFailureReason !== args.biometricAssessment.reason ||
    evidence.approvedAt !== record.completedAt.toISOString()
  ) {
    return null
  }
  return evidence
}
