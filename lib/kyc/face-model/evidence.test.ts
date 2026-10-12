import { describe, expect, it } from "vitest"
import { faceModelEvidenceRefusal, type FaceModelEvidence } from "./evidence"
import { FACE_MODELS, FACE_SIMILARITY_THRESHOLD } from "./models"

const passing: FaceModelEvidence = {
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

describe("faceModelEvidenceRefusal", () => {
  it("accepts evidence that re-proves a same-person decision", () => {
    expect(faceModelEvidenceRefusal(passing)).toBeNull()
    expect(faceModelEvidenceRefusal({ ...passing, idFaceCount: 2, idSecondFaceAreaRatio: 0.12 })).toBeNull()
    expect(faceModelEvidenceRefusal({ ...passing, idFaceCount: 2, idSecondFaceAreaRatio: 0.5 })).toBeNull()
    expect(faceModelEvidenceRefusal({ ...passing, similarity: 1 })).toBeNull()
  })

  it("accepts a similarity exactly at the threshold and refuses one just below", () => {
    expect(faceModelEvidenceRefusal({ ...passing, similarity: FACE_SIMILARITY_THRESHOLD })).toBeNull()
    expect(faceModelEvidenceRefusal({ ...passing, similarity: 0.36299999 })).toBe("match_score_below_threshold")
  })

  it.each([
    ["not an object", null],
    ["an array", [passing]],
    ["another detector", { ...passing, detector: "face_detection_yunet_2023mar_int8" }],
    ["a tampered detector checksum", { ...passing, detectorSha256: "0".repeat(64) }],
    ["another recognizer", { ...passing, recognizer: "face_recognition_sface_2021dec_int8" }],
    ["a tampered recognizer checksum", { ...passing, recognizerSha256: "0".repeat(64) }],
    ["two selfie faces", { ...passing, selfieFaceCount: 2 }],
    ["no selfie face", { ...passing, selfieFaceCount: 0 }],
    ["a string selfie count", { ...passing, selfieFaceCount: "1" }],
    ["no ID face", { ...passing, idFaceCount: 0 }],
    ["a fractional ID count", { ...passing, idFaceCount: 1.5 }],
    ["one ID face with a second-face ratio", { ...passing, idSecondFaceAreaRatio: 0.2 }],
    ["two ID faces without a ratio", { ...passing, idFaceCount: 2 }],
    ["two comparable ID faces", { ...passing, idFaceCount: 2, idSecondFaceAreaRatio: 0.51 }],
    ["a negative ratio", { ...passing, idFaceCount: 2, idSecondFaceAreaRatio: -0.1 }],
    ["a lowered threshold", { ...passing, threshold: 0.2, similarity: 0.3 }],
    ["a raised threshold", { ...passing, threshold: 0.5 }],
    ["samePerson false", { ...passing, samePerson: false }],
    ["samePerson as a string", { ...passing, samePerson: "true" }],
    ["a similarity above 1", { ...passing, similarity: 1.0001 }],
    ["a string similarity", { ...passing, similarity: "0.71" }],
    ["a missing similarity", { ...passing, similarity: undefined }],
  ])("refuses %s", (_label, evidence) => {
    expect(faceModelEvidenceRefusal(evidence)).toBe("provider_verification_failed")
  })

  it("refuses samePerson true over a similarity below the threshold", () => {
    expect(faceModelEvidenceRefusal({ ...passing, similarity: 0.2 })).toBe("match_score_below_threshold")
  })
})
