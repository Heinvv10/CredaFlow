import {
  assessBiometricEvidence,
  assessVlmBiometricExtraction,
  VLM_FACE_MATCH_PROVIDER,
  type BiometricEvidenceFailureReason,
  type BiometricIdDocument,
  type BiometricSubjectClient,
} from "@/lib/kyc/biometric-evidence"
import {
  readVlmFaceMatchSideRejection,
  readVlmFaceMatchVerdict,
  type IdPhotoKind,
  type SamePersonVerdict,
  type VlmFaceMatchSideJudgement,
} from "@/lib/kyc/vlm-face-match"
import { isManualKycExceptionableFailureReason } from "@/lib/kyc/manual-exception-policy"
import type { FaceComparison } from "@/lib/kyc/face-model/compare.server"
import type { FaceModelEvidence } from "@/lib/kyc/face-model/evidence"
import type { extractDocumentData } from "@/lib/vlm-extract"

/**
 * The decision step of the selfie pipeline (runBiometricVerification, Step C):
 * from the two judges' outputs to the provider result, the pass/fail and the
 * recorded failure reason. Pure, so the demo kit check
 * (scripts/demo/kits/verify-face-match.ts) runs the same decision without a
 * database. Moved VERBATIM from lib/kyc/selfie-biometric.server.ts; a change
 * here is a KYC change.
 */

// The provider evidence written for every attempt. `assessBiometricEvidence`
// enforces ok/verified/matchScore/livenessScore/subjectFingerprint on this
// shape, so removing a field here closes the biometric path, never opens it.
export type VlmFaceMatchProviderResult = {
  ok: boolean
  verified: boolean
  provider: typeof VLM_FACE_MATCH_PROVIDER
  matchScore: number
  livenessScore: number
  /** Raw 0–1 confidences; the thresholds are applied to these. */
  matchConfidence: number
  livenessConfidence: number
  faceMatch: boolean
  idPhotoFaceDetected: boolean
  /** What the VLM saw in the ID portrait area; only "photograph" can verify. */
  idPhotoKind: IdPhotoKind
  idPhotoIsRealPhotograph: boolean
  selfieIsRealPhotograph: boolean
  samePerson: SamePersonVerdict
  /**
   * The face model's comparison. It alone decides same-person: the VLM's own
   * samePerson/faceMatch/matchConfidence above can only refuse.
   */
  faceModel: FaceModelEvidence
  /** Which stored ID document the selfie was compared against. */
  idDocumentId: string
  idDocumentSha256: string | null
  error?: string
}

/** A strict refusal's side judgements when no provider result was written. */
export type StrictRejectionJudgement = VlmFaceMatchSideJudgement & {
  provider: typeof VLM_FACE_MATCH_PROVIDER
  rejection: string
}

export type BiometricAttemptDecision = {
  extractionResult: unknown
  extractionStatus: "done" | "failed"
  extractionError: string | null
  biometricResult: VlmFaceMatchProviderResult | null
  biometricPassed: boolean
  biometricFailureReason: BiometricEvidenceFailureReason | null
  strictJudgement: StrictRejectionJudgement | null
}

export function decideBiometricAttempt({
  vlmResult,
  faceComparison,
  preparationRejection,
  subject,
  subjectFingerprint,
  idDocument,
}: {
  vlmResult: Awaited<ReturnType<typeof extractDocumentData>>
  /** null when the images could not be prepared and no comparison ran. */
  faceComparison: FaceComparison | null
  preparationRejection: { reason: "extraction_incomplete"; message: string } | null
  /** The subject on file, null when the client row was not found. */
  subject: BiometricSubjectClient | null
  subjectFingerprint: string | null
  /** The ID copy the selfie was compared against. */
  idDocument: BiometricIdDocument
}): BiometricAttemptDecision {
  const extractionUnavailable = !vlmResult.ok && vlmResult.error?.includes('AI document extraction is not configured')

  // Step C: derive the provider result from the VLM's own verdict. There is
  // no external provider any more (Smile Identity was never configured and
  // only ever returned simulated literals, which the KYC gate rejects). A
  // missing or malformed verdict yields NO provider evidence — fail closed.
  // With the VLM unconfigured there is no biometric provider at all: the
  // attempt fails and the in-person route remains the fallback.
  const extractionResult = extractionUnavailable
    ? { vlmUnavailable: true }
    : vlmResult.data ?? null
  const vlmAssessment = assessVlmBiometricExtraction(extractionResult)
  // Read the verdict even when the selfie side already failed: the ID-side
  // judgement must still be able to name a reason no human may except.
  const matchVerdict = extractionUnavailable
    ? null
    : readVlmFaceMatchVerdict(extractionResult)
  const modelRejection = faceComparison?.rejection ?? null
  // A refusal that can never be excepted (ID portrait or selfie not a real
  // photograph). It outranks every other failure, whichever side failed
  // first: a liveness or face-count failure is exceptionable, and recording
  // it instead let a senior except a match against a silhouette ID. When
  // the full verdict is unreadable (any one malformed field) or names only
  // an exceptionable refusal, the side judgements are read on their own.
  // The side reader refuses on exactly the fields the strict verdict's
  // non-exceptionable refusals read, so it also supplies their judgements.
  // The face model's own strict refusals (no usable ID face, the model
  // unavailable) come after the VLM's.
  const sideRejection = extractionUnavailable
    ? null
    : readVlmFaceMatchSideRejection(extractionResult)
  const strictRejection = preparationRejection ?? (matchVerdict?.rejection &&
    !isManualKycExceptionableFailureReason(matchVerdict.rejection.reason)
    ? matchVerdict.rejection
    : sideRejection)
    ?? (modelRejection && !isManualKycExceptionableFailureReason(modelRejection.reason)
      ? modelRejection
      : null)
  let biometricResult: VlmFaceMatchProviderResult | null = null
  if (vlmAssessment.ok && matchVerdict && subject?.idNumber && faceComparison?.ok) {
    const refusal = strictRejection ?? modelRejection ?? matchVerdict.rejection
    biometricResult = {
      ok: true,
      // Every VLM gate in readVlmFaceMatchVerdict AND the face model must
      // hold. faceMatch alone once verified a selfie against a silhouette
      // placeholder, and the VLM's "same" cannot outvote the model.
      verified: matchVerdict.rejection === null && faceComparison.rejection === null,
      provider: VLM_FACE_MATCH_PROVIDER,
      matchScore: matchVerdict.matchScore,
      livenessScore: matchVerdict.livenessScore,
      matchConfidence: matchVerdict.matchConfidence,
      livenessConfidence: matchVerdict.livenessConfidence,
      faceMatch: matchVerdict.faceMatch,
      idPhotoFaceDetected: matchVerdict.idPhotoFaceDetected,
      idPhotoKind: matchVerdict.idPhotoKind,
      idPhotoIsRealPhotograph: matchVerdict.idPhotoIsRealPhotograph,
      selfieIsRealPhotograph: matchVerdict.selfieIsRealPhotograph,
      samePerson: matchVerdict.samePerson,
      faceModel: faceComparison.evidence,
      idDocumentId: idDocument.id,
      idDocumentSha256: idDocument.contentSha256,
      ...(refusal === null ? {} : { error: refusal.message }),
    }
  }
  // The judgements behind a strict refusal, for the audit row when no
  // provider result carries them.
  const strictJudgement: StrictRejectionJudgement | null =
    strictRejection && sideRejection && !biometricResult
      ? {
          provider: VLM_FACE_MATCH_PROVIDER,
          rejection: strictRejection.message,
          ...sideRejection.judgement,
        }
      : null
  // A completed check that refused carries its own message; only an attempt
  // with no provider result falls back to the VLM/transport error.
  const extractionError = biometricResult
    ? biometricResult.error ?? null
    : strictRejection?.message
      // A face-model refusal is the assessment below whenever the VLM's own
      // liveness gates passed, so its message is the one that is true.
      ?? (vlmAssessment.ok && faceComparison && !faceComparison.ok ? faceComparison.rejection.message : null)
      ?? vlmResult.error
      ?? "Biometric verification did not run"

  const biometricCompleted = biometricResult?.ok === true
  const extractionStatus = biometricCompleted ? "done" as const : "failed" as const
  const prospectiveAssessment = !vlmAssessment.ok
    ? vlmAssessment
    // A face model that refused before computing a similarity left no
    // provider result; its reason, not "extraction incomplete", is the
    // assessment.
    : faceComparison && !faceComparison.ok
    ? { ok: false as const, reason: faceComparison.rejection.reason }
    : subject && subjectFingerprint
    ? assessBiometricEvidence({
        deletedAt: null,
        verified: false,
        extractionStatus,
        extractionResult,
        extractionError,
        validationMismatch: false,
        validationScore: biometricResult?.matchScore ?? 0,
        biometricMatchScore: biometricResult?.matchScore ?? null,
        biometricLiveness: biometricResult?.livenessScore ?? null,
        biometricVerifiedAt: biometricCompleted ? new Date() : null,
        biometricResult: biometricResult
          ? { ...biometricResult, subjectFingerprint }
          : null,
      }, {
        subject,
        // The copy capture compared against. This decides only whether the
        // match itself passed; the composite gate decides whether it counts.
        idDocument,
        // Bound to the compared copy by construction; nothing to flag.
        idDocumentCopies: null,
        requireDocumentVerified: false,
      })
    : { ok: false as const, reason: "subject_fingerprint_missing" as const }
  const biometricPassed = prospectiveAssessment.ok
  const assessedReason = prospectiveAssessment.ok ? null : prospectiveAssessment.reason
  // The strictest reason is the one recorded: a non-exceptionable refusal
  // from either source wins. Otherwise a completed check names its own
  // refusal (not the generic provider_verification_failed or score gate),
  // the face model's ahead of the VLM's, and an attempt stopped on the
  // selfie side keeps that gate's reason.
  const biometricFailureReason = strictRejection?.reason
    ?? (assessedReason && !isManualKycExceptionableFailureReason(assessedReason)
      ? assessedReason
      : null)
    ?? (biometricResult ? (modelRejection ?? matchVerdict?.rejection)?.reason : null)
    ?? assessedReason

  return {
    extractionResult,
    extractionStatus,
    extractionError,
    biometricResult,
    biometricPassed,
    biometricFailureReason,
    strictJudgement,
  }
}
