/**
 * The face model's part of v3 biometric evidence, and the check that the
 * stored fields re-prove a same-person decision. Mirrored in SQL by
 * subject_has_composite_kyc (migration 20261011080000_face_match_v3_evidence).
 */
import { FACE_MODELS, FACE_SIMILARITY_THRESHOLD, ID_SECOND_FACE_MAX_AREA_RATIO } from "./models"

export type FaceModelEvidence = {
  detector: string
  detectorSha256: string
  recognizer: string
  recognizerSha256: string
  selfieFaceCount: number
  idFaceCount: number
  /** Largest other ID face's box area over the compared face's; null with one face. */
  idSecondFaceAreaRatio: number | null
  /** Cosine similarity of the two embeddings, -1..1. */
  similarity: number
  threshold: number
  samePerson: boolean
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

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
      : idFaceCount > 1 && isNumber(ratio) && ratio >= 0 && ratio <= ID_SECOND_FACE_MAX_AREA_RATIO
  )
  if (
    evidence.detector !== FACE_MODELS.detector.name ||
    evidence.detectorSha256 !== FACE_MODELS.detector.sha256 ||
    evidence.recognizer !== FACE_MODELS.recognizer.name ||
    evidence.recognizerSha256 !== FACE_MODELS.recognizer.sha256 ||
    evidence.selfieFaceCount !== 1 ||
    !idFaceRuleHolds ||
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
