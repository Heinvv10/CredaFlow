import {
  BIOMETRIC_LIVENESS_THRESHOLD,
  BIOMETRIC_MATCH_THRESHOLD,
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
  /**
   * null only when EVERY gate below holds; otherwise the first gate that
   * refused. This — not `faceMatch` — is what decides `verified`.
   */
  rejection: string | null
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
 * The model's separate judgements are cross-checked here, in code, so no
 * single optimistic boolean can carry a match. Any disagreement fails.
 */
function rejectionFor(v: Omit<VlmFaceMatchVerdict, "rejection">): string | null {
  if (v.idPhotoKind !== "photograph") {
    return `ID document portrait is not a photograph (${v.idPhotoKind})`
  }
  if (!v.idPhotoIsRealPhotograph) return "ID document portrait is not a real photograph of a person"
  if (!v.idPhotoFaceDetected) return "No face detected in the ID document photograph"
  if (!v.selfieIsRealPhotograph) return "Selfie is not a real photograph of a live person"
  if (v.samePerson !== "same" || !v.faceMatch) {
    return "VLM face match did not confirm the selfie against the ID photograph"
  }
  if (v.matchScore < BIOMETRIC_MATCH_THRESHOLD) return "Face match confidence below threshold"
  if (v.livenessScore < BIOMETRIC_LIVENESS_THRESHOLD) return "Liveness confidence below threshold"
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
  }
  return { ...verdict, rejection: rejectionFor(verdict) }
}
