/**
 * Face-model evidence that re-proves a pass, for tests that build v3
 * biometric evidence. Synthetic: no image stands behind it.
 */
import type { FaceModelEvidence } from "./evidence"
import { FACE_MODELS, FACE_MODEL_DETECTOR_RUNTIME_SHA256, FACE_SIMILARITY_THRESHOLD } from "./models"

export const PASSING_FACE_MODEL_EVIDENCE: FaceModelEvidence = {
  detector: FACE_MODELS.detector.name,
  detectorSha256: FACE_MODELS.detector.sha256,
  detectorRuntimeSha256: FACE_MODEL_DETECTOR_RUNTIME_SHA256,
  recognizer: FACE_MODELS.recognizer.name,
  recognizerSha256: FACE_MODELS.recognizer.sha256,
  selfieFaceCount: 1,
  idFaceCount: 1,
  idSecondFaceAreaRatio: null,
  idDetectPass: "fit640",
  idInterOcularPx: 100,
  selfieInterOcularPx: 240,
  idGeometryMargin: 0.4,
  selfieGeometryMargin: 0.5,
  idSharpness: 1100,
  selfieSharpness: 1200,
  similarity: 0.71,
  threshold: FACE_SIMILARITY_THRESHOLD,
  samePerson: true,
}
