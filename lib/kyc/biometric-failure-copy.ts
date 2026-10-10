// Type-only import: this module is pulled into the client bundle by
// SelfieKycTab, and lib/kyc/biometric-evidence.ts imports node:crypto.
// `import type` is erased at compile time, so no runtime edge is created.
import type { BiometricEvidenceFailureReason } from "@/lib/kyc/biometric-evidence"

export interface BiometricFailureCopy {
  /** Headline a staff member reads first. */
  label: string
  /** One sentence saying what actually happened to this attempt. */
  detail: string
}

/**
 * Staff-facing wording for every reason the composite KYC gate can refuse a
 * selfie.
 *
 * The enum values are internal identifiers, not English. Rendering them raw
 * printed "SUBJECT FINGERPRINT MISSING" on the KYC screen, which reads as a
 * missing fingerprint scan — a biometric the lender does not collect and never
 * has. Identity is checked by comparing the selfie against the photograph on
 * the ID document (the VLM face match). "Subject fingerprint" is the SHA-256
 * digest that binds a check result to one client record
 * (`biometricSubjectFingerprint`), and that word must not reach the UI.
 *
 * Keyed by the full union, so a new failure reason cannot ship without wording.
 */
export const BIOMETRIC_FAILURE_COPY: Record<
  BiometricEvidenceFailureReason,
  BiometricFailureCopy
> = {
  // --- No usable result exists, or it is not bound to this client. ---
  extraction_incomplete: {
    label: "Identity check did not finish",
    detail: "The check on this selfie never completed, so there is no result to review.",
  },
  biometric_evidence_missing: {
    label: "No identity check on record",
    detail: "This selfie has no completed identity check recorded against it.",
  },
  document_deleted: {
    label: "Selfie was deleted",
    detail: "The selfie this result belongs to has been deleted, so it is no longer evidence.",
  },
  document_not_verified: {
    label: "Selfie not verified",
    detail: "This selfie has not been marked verified, so its result cannot be relied on.",
  },
  superseded_biometric_evidence: {
    label: "Replaced by a newer selfie",
    detail: "A newer selfie has since been captured, so this result is no longer the current one.",
  },
  subject_fingerprint_missing: {
    label: "Not linked to this client's record",
    detail:
      "This check carries no link to a client record — either it predates that linking, or the link could not be recorded — so the result cannot be tied to this client.",
  },
  subject_identity_changed: {
    // Two triggers, and the copy must be true for both: the identity hash no
    // longer matching (assessBiometricEvidence, and the same comparison in
    // lib/kyc/selfie-biometric.server.ts), and the bound ID document being
    // replaced. Naming specific fields would be false for the second.
    //
    // There used to be a third — ANY edit to the client row while the check was
    // in flight, because the in-flight comparison was on the row-wide
    // Client.updatedAt rather than on the identity fields. That was a false
    // positive: unrelated writes failed valid attempts. It now compares the
    // same fingerprint, so this reason no longer fires for an unrelated edit.
    label: "Record changed after the check",
    detail:
      "The client record or the ID document this check was run against has changed since this check began, so the result no longer describes what is on file now.",
  },
  provider_verification_missing: {
    label: "Scores have no completed check behind them",
    detail:
      "Scores are stored for this selfie, but there is no completed identity check backing them.",
  },
  simulated_provider_evidence: {
    label: "Test result, not a real check",
    detail: "This result came from a test run rather than a real identity check.",
  },
  // A real check ran, but one side holds no real face to compare. NOT on the
  // exception allow-list: the remedy is new evidence, not a senior override.
  id_document_portrait_invalid: {
    label: "ID document has no usable photograph",
    detail:
      "The photo area of the ID document on file is not a real photograph of a face (for example a silhouette, drawing, blank or covered photo), so the selfie could not be compared. The client must upload a new, clear photo of their ID.",
  },
  selfie_not_real_photograph: {
    label: "Selfie is not a real photograph",
    detail:
      "The check judged this selfie not to be a camera photograph of a real person, so it could not be compared. The client must retake a real, live selfie.",
  },

  // --- A real check ran and returned an adverse result. These are the
  // reasons a senior may reason over (MANUAL_KYC_EXCEPTIONABLE_FAILURE_REASONS).
  face_not_detected: {
    label: "No face found in the selfie",
    detail: "The check could not find a face in this photo.",
  },
  face_count_invalid: {
    // The condition is facesCount !== 1 — zero, several, or a malformed count.
    label: "Selfie does not show exactly one face",
    detail: "The check needs exactly one face in the photo to compare against the ID.",
  },
  vlm_liveness_failed: {
    label: "Not confirmed as a live person",
    detail:
      "The check could not confirm this is a live person rather than a photo of a photo or a screen.",
  },
  image_unusable: {
    label: "Photo quality too poor to check",
    detail: "The check rated this photo unusable for comparison against the ID photograph.",
  },
  validation_mismatch: {
    // A generic "did not validate" flag, not a face-comparison verdict — and
    // currently unreachable for a selfie, because the writer always couples
    // validationMismatch:true with extractionStatus:"failed", which
    // assessBiometricEvidence short-circuits on first. Kept truthful and
    // non-specific rather than describing a comparison this flag never carries.
    label: "Check result marked as not matching",
    detail:
      "The stored result for this selfie is flagged as not matching this client's details, so it cannot be accepted.",
  },
  match_score_below_threshold: {
    label: "Face match too low to accept",
    detail:
      "The selfie and the ID photograph did not match closely enough to meet the required standard.",
  },
  liveness_score_below_threshold: {
    label: "Liveness too low to accept",
    detail: "The check was not confident enough that the selfie is of a live person.",
  },
  provider_verification_failed: {
    label: "Identity check did not pass",
    detail: "The check ran against the ID photograph and did not pass.",
  },
}

// A plain object literal inherits Object.prototype keys, so a lookup for
// "constructor" or "__proto__" would return a function instead of undefined.
// The reason reaches here as a bare string, so use a Map.
const COPY = new Map<string, BiometricFailureCopy>(Object.entries(BIOMETRIC_FAILURE_COPY))

/** Null for an unrecognised reason, so callers fall back rather than invent copy. */
export function biometricFailureCopy(reason: string | null | undefined): BiometricFailureCopy | null {
  if (!reason) return null
  return COPY.get(reason) ?? null
}

/**
 * What the CLIENT is told on the portal when their latest selfie failed. Only
 * a refusal with a different remedy gets its own wording; everything else
 * keeps the generic retake instruction.
 */
export function portalSelfieFailureMessage(reason: string | null | undefined): string {
  if (reason === "id_document_portrait_invalid") {
    return "We could not see a clear photograph of you on your ID document. Please upload a new, clear photo of your ID, then retake your selfie."
  }
  if (reason === "selfie_not_real_photograph") {
    return "Your selfie could not be confirmed as a real, live photo of you. Please retake it with your camera, facing it directly."
  }
  return "The latest selfie could not be verified. Please retake it."
}
