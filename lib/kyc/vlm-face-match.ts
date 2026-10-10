import {
  BIOMETRIC_LIVENESS_THRESHOLD,
  BIOMETRIC_MATCH_THRESHOLD,
  type BiometricEvidenceFailureReason,
} from "@/lib/kyc/biometric-evidence"

/**
 * What the VLM says occupies the portrait area of the ID document. Only
 * "photograph" can ever pass: a selfie "matched" against a silhouette, a
 * cartoon, an empty box or a covered photo is a match against nobody
 * (2026-10-10: a grey-silhouette specimen card scored faceMatch=true at 0.85,
 * 3/3 runs, under the old single-boolean prompt).
 */
export const ID_PHOTO_KINDS = [
  "photograph",
  "silhouette_placeholder",
  "illustration",
  "blank_or_missing",
  "obscured",
  "other",
] as const
export type IdPhotoKind = (typeof ID_PHOTO_KINDS)[number]

export const SAME_PERSON_VERDICTS = ["same", "different", "uncertain"] as const
export type SamePersonVerdict = (typeof SAME_PERSON_VERDICTS)[number]

/**
 * The failure reason recorded for each refusal. ID-side and selfie-side
 * refusals get their own reasons, which are deliberately NOT on the manual
 * KYC exception allow-list: there is no real face on one side to reason over.
 */
export type VlmFaceMatchRejectionReason = Extract<
  BiometricEvidenceFailureReason,
  | "id_document_portrait_invalid"
  | "selfie_not_real_photograph"
  | "provider_verification_failed"
  | "match_score_below_threshold"
  | "liveness_score_below_threshold"
>

export type VlmFaceMatchRejection = {
  reason: VlmFaceMatchRejectionReason
  /** Persisted as the attempt's extraction error and verification note. */
  message: string
}

export type VlmFaceMatchVerdict = {
  faceMatch: boolean
  idPhotoFaceDetected: boolean
  idPhotoKind: IdPhotoKind
  idPhotoIsRealPhotograph: boolean
  selfieIsRealPhotograph: boolean
  samePerson: SamePersonVerdict
  /** 0–100, from the VLM's matchConfidence (0–1). */
  matchScore: number
  /** 0–100, from the VLM's livenessConfidence (0–1). */
  livenessScore: number
  /** The raw 0–1 confidences the thresholds are compared against. */
  matchConfidence: number
  livenessConfidence: number
  /**
   * null only when EVERY gate below holds; otherwise the first gate that
   * refused. This — not `faceMatch` — is what decides `verified`.
   */
  rejection: VlmFaceMatchRejection | null
}

function extractedValue(result: Record<string, unknown>, field: string): unknown {
  const entry = result[field]
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
  return (entry as Record<string, unknown>).value
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return (allowed as readonly string[]).includes(normalized) ? normalized as T : null
}

/**
 * Every judgement below comes from the same model in the same response, so
 * this is not independent corroboration: a model that is wrong about the
 * portrait can be consistently wrong across all of them. What it does buy is
 * that the portrait is classified separately from the match and every field
 * must agree, so any one refusing judgement fails the attempt.
 *
 * Thresholds compare the RAW confidence, never the rounded 0–100 score, so a
 * 0.6951 cannot round up to a 70 pass.
 */
function rejectionFor(
  v: Omit<VlmFaceMatchVerdict, "rejection">,
): VlmFaceMatchRejection | null {
  const refuse = (reason: VlmFaceMatchRejectionReason, message: string) => ({ reason, message })
  if (v.idPhotoKind !== "photograph") {
    return refuse("id_document_portrait_invalid", `ID document portrait is not a photograph (${v.idPhotoKind})`)
  }
  if (!v.idPhotoIsRealPhotograph) {
    return refuse("id_document_portrait_invalid", "ID document portrait is not a real photograph of a person")
  }
  if (!v.idPhotoFaceDetected) {
    return refuse("id_document_portrait_invalid", "No face detected in the ID document photograph")
  }
  if (!v.selfieIsRealPhotograph) {
    return refuse("selfie_not_real_photograph", "Selfie is not a real photograph of a live person")
  }
  if (v.samePerson !== "same" || !v.faceMatch) {
    return refuse(
      "provider_verification_failed",
      "VLM face match did not confirm the selfie against the ID photograph",
    )
  }
  if (v.matchConfidence < BIOMETRIC_MATCH_THRESHOLD / 100) {
    return refuse("match_score_below_threshold", "Face match confidence below threshold")
  }
  if (v.livenessConfidence < BIOMETRIC_LIVENESS_THRESHOLD / 100) {
    return refuse("liveness_score_below_threshold", "Liveness confidence below threshold")
  }
  return null
}

/** The ID/selfie-side judgements, as far as they are readable. No personal data. */
export type VlmFaceMatchSideJudgement = {
  /** A known kind, "unrecognised" for any other present value, null if absent. */
  idPhotoKind: IdPhotoKind | "unrecognised" | null
  idPhotoIsRealPhotograph: boolean | null
  idPhotoFaceDetected: boolean | null
  selfieIsRealPhotograph: boolean | null
}

/**
 * The ID/selfie-side refusal, read field by field. readVlmFaceMatchVerdict
 * returns null when ANY field is malformed, so an unrelated bad confidence
 * hid a silhouette ID behind an exceptionable selfie-side reason. This reads
 * only the side judgements: a present idPhotoKind other than "photograph"
 * (unknown kinds included), or an explicit false, refuses. Absent or null
 * fields say nothing either way. ID side first, as in rejectionFor.
 */
export function readVlmFaceMatchSideRejection(
  extractionResult: unknown,
): (VlmFaceMatchRejection & { judgement: VlmFaceMatchSideJudgement }) | null {
  if (!extractionResult || typeof extractionResult !== "object" || Array.isArray(extractionResult)) {
    return null
  }
  const extraction = extractionResult as Record<string, unknown>
  const rawKind = extractedValue(extraction, "idPhotoKind")
  const flag = (field: string) => {
    const value = extractedValue(extraction, field)
    return typeof value === "boolean" ? value : null
  }
  const judgement: VlmFaceMatchSideJudgement = {
    idPhotoKind: rawKind === undefined || rawKind === null
      ? null
      : oneOf(ID_PHOTO_KINDS, rawKind) ?? "unrecognised",
    idPhotoIsRealPhotograph: flag("idPhotoIsRealPhotograph"),
    idPhotoFaceDetected: flag("idPhotoFaceDetected"),
    selfieIsRealPhotograph: flag("selfieIsRealPhotograph"),
  }
  const refuse = (reason: VlmFaceMatchRejectionReason, message: string) => ({ reason, message, judgement })
  if (judgement.idPhotoKind !== null && judgement.idPhotoKind !== "photograph") {
    return refuse("id_document_portrait_invalid", `ID document portrait is not a photograph (${judgement.idPhotoKind})`)
  }
  if (judgement.idPhotoIsRealPhotograph === false) {
    return refuse("id_document_portrait_invalid", "ID document portrait is not a real photograph of a person")
  }
  if (judgement.idPhotoFaceDetected === false) {
    return refuse("id_document_portrait_invalid", "No face detected in the ID document photograph")
  }
  if (judgement.selfieIsRealPhotograph === false) {
    return refuse("selfie_not_real_photograph", "Selfie is not a real photograph of a live person")
  }
  return null
}

/**
 * Read the two-image face-match verdict out of a SELFIE extraction result.
 * Returns null — never a partial verdict — unless every field is present and
 * well-formed, so a single-image (legacy) extraction or a malformed VLM
 * response yields no provider evidence and the attempt fails closed.
 */
export function readVlmFaceMatchVerdict(extractionResult: unknown): VlmFaceMatchVerdict | null {
  if (!extractionResult || typeof extractionResult !== "object" || Array.isArray(extractionResult)) {
    return null
  }
  const extraction = extractionResult as Record<string, unknown>
  const faceMatch = extractedValue(extraction, "faceMatch")
  const idPhotoFaceDetected = extractedValue(extraction, "idPhotoFaceDetected")
  const idPhotoIsRealPhotograph = extractedValue(extraction, "idPhotoIsRealPhotograph")
  const selfieIsRealPhotograph = extractedValue(extraction, "selfieIsRealPhotograph")
  const idPhotoKind = oneOf(ID_PHOTO_KINDS, extractedValue(extraction, "idPhotoKind"))
  const samePerson = oneOf(SAME_PERSON_VERDICTS, extractedValue(extraction, "samePerson"))
  const matchConfidence = extractedValue(extraction, "matchConfidence")
  const livenessConfidence = extractedValue(extraction, "livenessConfidence")
  const isConfidence = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
  if (
    typeof faceMatch !== "boolean"
    || typeof idPhotoFaceDetected !== "boolean"
    || typeof idPhotoIsRealPhotograph !== "boolean"
    || typeof selfieIsRealPhotograph !== "boolean"
    || idPhotoKind === null
    || samePerson === null
    || !isConfidence(matchConfidence)
    || !isConfidence(livenessConfidence)
  ) {
    return null
  }
  const verdict = {
    faceMatch,
    idPhotoFaceDetected,
    idPhotoKind,
    idPhotoIsRealPhotograph,
    selfieIsRealPhotograph,
    samePerson,
    matchScore: Math.round(matchConfidence * 100),
    livenessScore: Math.round(livenessConfidence * 100),
    matchConfidence,
    livenessConfidence,
  }
  return { ...verdict, rejection: rejectionFor(verdict) }
}
