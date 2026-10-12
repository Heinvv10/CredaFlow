/**
 * Face-model evidence that re-proves a pass, for tests that build v3
 * biometric evidence. Synthetic: no image stands behind it.
 */
import type { FaceModelEvidence } from "./evidence"
import { FACE_MODELS, FACE_SIMILARITY_THRESHOLD } from "./models"

export const PASSING_FACE_MODEL_EVIDENCE: FaceModelEvidence = {
  detector: FACE_MODELS.detector.name,
  detectorSha256: FACE_MODELS.detector.sha256,
  recognizer: FACE_MODELS.recognizer.name,
  recognizerSha256: FACE_MODELS.recognizer.sha256,
  selfieFaceCount: 1,
  idFaceCount: 1,
  idSecondFaceAreaRatio: null,
  similarity: 0.71,
  threshold: FACE_SIMILARITY_THRESHOLD,
  samePerson: true,
}
