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
  | "extraction_incomplete"
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

/**
 * A side flag as read: "unrecognised" for any present value that is not a
 * boolean, null if absent.
 */
export type VlmFaceMatchSideFlag = boolean | "unrecognised" | null

/** The ID/selfie-side judgements, as far as they are readable. No personal data. */
export type VlmFaceMatchSideJudgement = {
  /** A known kind, "unrecognised" for any other present value, null if absent. */
  idPhotoKind: IdPhotoKind | "unrecognised" | null
  idPhotoIsRealPhotograph: VlmFaceMatchSideFlag
  idPhotoFaceDetected: VlmFaceMatchSideFlag
  selfieIsRealPhotograph: VlmFaceMatchSideFlag
}

/**
 * The ID/selfie-side refusal, read field by field. readVlmFaceMatchVerdict
 * returns null when ANY field is malformed, so an unrelated bad confidence
 * hid a silhouette ID behind an exceptionable selfie-side reason. This reads
 * only the side judgements and fails closed: once the model has answered, an
 * absent or null judgement refuses (mapExtractedFields drops null, so "no
 * answer about the portrait" must not read as "no objection"), and any other
 * value refuses unless it is exactly true (or, for
 * idPhotoKind, "photograph" after normalisation). A "false" string, a 0 or a
 * value nested inside the one { value } wrapper mapExtractedFields writes is
 * a refusal, not silence. ID side first, as in rejectionFor; within a side an
 * explicit judgement names the message ahead of an unreadable one, which gets
 * a message that claims nothing about the photo.
 */
export function readVlmFaceMatchSideRejection(
  extractionResult: unknown,
): (VlmFaceMatchRejection & { judgement: VlmFaceMatchSideJudgement }) | null {
  if (!extractionResult || typeof extractionResult !== "object" || Array.isArray(extractionResult)) {
    return null
  }
  const extraction = extractionResult as Record<string, unknown>
  if (extraction.vlmUnavailable === true) return null
  const rawKind = extractedValue(extraction, "idPhotoKind")
  const flag = (field: string): VlmFaceMatchSideFlag => {
    const value = extractedValue(extraction, field)
    if (value === undefined || value === null) return null
    return typeof value === "boolean" ? value : "unrecognised"
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
  // A reply that judged neither photo is a fault in the check, not in the ID:
  // telling the client to upload a new ID would be the wrong remedy. It is
  // still not exceptionable, so it cannot fall through to a selfie-side reason.
  if (
    judgement.idPhotoKind === null
    && judgement.idPhotoIsRealPhotograph === null
    && judgement.idPhotoFaceDetected === null
    && judgement.selfieIsRealPhotograph === null
  ) {
    return refuse("extraction_incomplete", "The face match check gave no answer about either photo")
  }
  if (judgement.idPhotoKind !== null && judgement.idPhotoKind !== "photograph" && judgement.idPhotoKind !== "unrecognised") {
    return refuse("id_document_portrait_invalid", `ID document portrait is not a photograph (${judgement.idPhotoKind})`)
  }
  if (judgement.idPhotoIsRealPhotograph === false) {
    return refuse("id_document_portrait_invalid", "ID document portrait is not a real photograph of a person")
  }
  if (judgement.idPhotoFaceDetected === false) {
    return refuse("id_document_portrait_invalid", "No face detected in the ID document photograph")
  }
  if (
    judgement.idPhotoKind === "unrecognised"
    || judgement.idPhotoIsRealPhotograph === "unrecognised"
    || judgement.idPhotoFaceDetected === "unrecognised"
  ) {
    return refuse("id_document_portrait_invalid", "ID document portrait could not be verified: the check's answer about it was unreadable")
  }
  if (judgement.idPhotoKind === null || judgement.idPhotoIsRealPhotograph === null || judgement.idPhotoFaceDetected === null) {
    return refuse("id_document_portrait_invalid", "ID document portrait could not be verified: the check gave no answer about it")
  }
  if (judgement.selfieIsRealPhotograph === false) {
    return refuse("selfie_not_real_photograph", "Selfie is not a real photograph of a live person")
  }
  if (judgement.selfieIsRealPhotograph === "unrecognised") {
    return refuse("selfie_not_real_photograph", "Selfie could not be verified as a real photograph: the check's answer about it was unreadable")
  }
  if (judgement.selfieIsRealPhotograph === null) {
    return refuse("selfie_not_real_photograph", "Selfie could not be verified as a real photograph: the check gave no answer about it")
  }
  return null
}

/**
 * The VLM's same-person answer, read field by field, so it survives every
 * failure path: readVlmFaceMatchVerdict yields nothing when any field is
 * malformed, and no provider result is written when a liveness or face-model
 * gate refused first. An absent field is null; any other value that is not
 * a known verdict (or a boolean) is "unrecognised". null when no reply was
 * read.
 */
export function readVlmSamePersonJudgement(extractionResult: unknown): {
  samePerson: SamePersonVerdict | "unrecognised" | null
  faceMatch: boolean | "unrecognised" | null
} | null {
  if (!extractionResult || typeof extractionResult !== "object" || Array.isArray(extractionResult)) {
    return null
  }
  const extraction = extractionResult as Record<string, unknown>
  if (extraction.vlmUnavailable === true) return null
  const samePerson = extractedValue(extraction, "samePerson")
  const faceMatch = extractedValue(extraction, "faceMatch")
  return {
    samePerson: samePerson === undefined || samePerson === null
      ? null
      : oneOf(SAME_PERSON_VERDICTS, samePerson) ?? "unrecognised",
    faceMatch: faceMatch === undefined || faceMatch === null
      ? null
      : typeof faceMatch === "boolean" ? faceMatch : "unrecognised",
  }
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
