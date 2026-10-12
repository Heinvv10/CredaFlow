/**
 * The face model's part of v3 biometric evidence, and the check that the
 * stored fields re-prove a same-person decision. Mirrored in SQL by
 * subject_has_composite_kyc (migration 20261011080000_face_match_v3_evidence).
 */
import {
  FACE_MODELS,
  FACE_SIMILARITY_THRESHOLD,
  ID_MAX_FACE_COUNT,
  ID_SECOND_FACE_MAX_AREA_RATIO,
  MAX_ALIGNED_CROP_SHARPNESS,
  MAX_INTER_OCULAR_PX,
  MIN_ALIGNED_CROP_SHARPNESS,
  MIN_INTER_OCULAR_PX,
  MIN_LANDMARK_GEOMETRY_MARGIN,
} from "./models"

export type FaceModelEvidence = {
  detector: string
  detectorSha256: string
  recognizer: string
  recognizerSha256: string
  selfieFaceCount: number
  idFaceCount: number
  /** Largest other ID face's box area over the compared face's; null with one face. */
  idSecondFaceAreaRatio: number | null
  /** Each compared face's measures (quality.ts), re-checked against the floors. */
  idInterOcularPx: number
  selfieInterOcularPx: number
  idGeometryMargin: number
  selfieGeometryMargin: number
  idSharpness: number
  selfieSharpness: number
  /** Cosine similarity of the two embeddings, -1..1. */
  similarity: number
  threshold: number
  samePerson: boolean
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const within = (value: unknown, min: number, max: number) => isNumber(value) && value >= min && value <= max

/**
 * null when `value` re-proves a pass; otherwise the reason it does not. Every
 * field is checked against the pinned constants, not against itself, so a
 * lowered threshold or a swapped model cannot carry its own approval.
 */
export function faceModelEvidenceRefusal(
  value: unknown,
): "provider_verification_failed" | "match_score_below_threshold" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "provider_verification_failed"
  const evidence = value as Record<string, unknown>
  const { idFaceCount, idSecondFaceAreaRatio: ratio, similarity } = evidence
  const idFaceRuleHolds = isNumber(idFaceCount) && Number.isInteger(idFaceCount) && (
    idFaceCount === 1
      ? ratio === null
      : idFaceCount > 1 && idFaceCount <= ID_MAX_FACE_COUNT &&
        isNumber(ratio) && ratio > 0 && ratio <= ID_SECOND_FACE_MAX_AREA_RATIO
  )
  const facesUsable = (["id", "selfie"] as const).every((side) =>
    within(evidence[`${side}InterOcularPx`], MIN_INTER_OCULAR_PX, MAX_INTER_OCULAR_PX) &&
    within(evidence[`${side}GeometryMargin`], MIN_LANDMARK_GEOMETRY_MARGIN, 1) &&
    within(evidence[`${side}Sharpness`], MIN_ALIGNED_CROP_SHARPNESS, MAX_ALIGNED_CROP_SHARPNESS))
  if (
    evidence.detector !== FACE_MODELS.detector.name ||
    evidence.detectorSha256 !== FACE_MODELS.detector.sha256 ||
    evidence.recognizer !== FACE_MODELS.recognizer.name ||
    evidence.recognizerSha256 !== FACE_MODELS.recognizer.sha256 ||
    evidence.selfieFaceCount !== 1 ||
    !idFaceRuleHolds ||
    !facesUsable ||
    evidence.threshold !== FACE_SIMILARITY_THRESHOLD ||
    !isNumber(similarity) || similarity < -1 || similarity > 1
  ) {
    return "provider_verification_failed"
  }
  if (similarity < FACE_SIMILARITY_THRESHOLD) return "match_score_below_threshold"
  // A recorded "different" beside a passing similarity is not a pass either.
  if (evidence.samePerson !== true) return "provider_verification_failed"
  return null
}
