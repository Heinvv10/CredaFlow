export const MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS = 20
export const MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS = 20

export const MANUAL_KYC_EXCEPTIONABLE_FAILURE_REASONS = [
  "face_not_detected",
  "face_count_invalid",
  "vlm_liveness_failed",
  "image_unusable",
  "validation_mismatch",
  "match_score_below_threshold",
  "liveness_score_below_threshold",
  "provider_verification_failed",
] as const

export type ManualKycExceptionableFailureReason =
  (typeof MANUAL_KYC_EXCEPTIONABLE_FAILURE_REASONS)[number]

const EXCEPTIONABLE_FAILURE_REASONS = new Set<string>(
  MANUAL_KYC_EXCEPTIONABLE_FAILURE_REASONS,
)

/**
 * Edge whitespace removed by ECMAScript String.prototype.trim as of ES2026.
 * Keep this explicit set byte-for-byte aligned with
 * trim_manual_kyc_exception_text() in the baseline migration. Using
 * runtime-native trim functions would let JavaScript and PostgreSQL disagree
 * on tabs and Unicode whitespace.
 */
export const MANUAL_KYC_EXCEPTION_EDGE_WHITESPACE = [
  "\u0009",
  "\u000a",
  "\u000b",
  "\u000c",
  "\u000d",
  "\u0020",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
] as const

const EDGE_WHITESPACE = new Set<string>(
  MANUAL_KYC_EXCEPTION_EDGE_WHITESPACE,
)

export function normalizeManualKycExceptionText(value: string): string {
  const codePoints = Array.from(value)
  let start = 0
  let end = codePoints.length
  while (start < end && EDGE_WHITESPACE.has(codePoints[start])) start += 1
  while (end > start && EDGE_WHITESPACE.has(codePoints[end - 1])) end -= 1
  return codePoints.slice(start, end).join("")
}

/**
 * PostgreSQL length(text) counts Unicode code points, while JavaScript
 * String.length counts UTF-16 code units. Count code points here so application
 * validation cannot accept evidence text that the database predicate rejects.
 */
export function manualKycExceptionCharacterCount(value: string): number {
  return Array.from(normalizeManualKycExceptionText(value)).length
}

export function hasMinimumManualKycExceptionCharacters(
  value: string,
  minimum: number,
): boolean {
  return manualKycExceptionCharacterCount(value) >= minimum
}

export function isManualKycExceptionableFailureReason(
  value: unknown,
): value is ManualKycExceptionableFailureReason {
  return typeof value === "string" && EXCEPTIONABLE_FAILURE_REASONS.has(value)
}

export function isManualKycExceptionableAttempt(args: {
  extractionStatus: string
  biometricFailureReason: unknown
}): boolean {
  return (
    (args.extractionStatus === "failed" ||
      args.extractionStatus === "skipped") &&
    isManualKycExceptionableFailureReason(args.biometricFailureReason)
  )
}
