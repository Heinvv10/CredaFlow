import { describe, expect, it } from "vitest"
import { decideBiometricAttempt } from "./biometric-decision"
import { biometricSubjectFingerprint } from "./biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "./face-model/evidence.test-helpers"

const subject = {
  id: "client-1",
  idNumber: "9001015009087",
  firstName: "Synthetic",
  lastName: "Customer",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
}
const idDocument = { id: "id-doc-1", contentSha256: "c".repeat(64) }
const wrap = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value, validated: true }]))
const reply = (change: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: wrap({
    faceDetected: true, facesCount: 1, quality: "good", isLive: true, livenessConfidence: 0.95,
    selfieIsRealPhotograph: true, idPhotoKind: "photograph", idPhotoIsRealPhotograph: true,
    idPhotoFaceDetected: true, samePerson: "same", faceMatch: true, matchConfidence: 0.93, ...change,
  }),
})
const passingComparison = { ok: true as const, evidence: PASSING_FACE_MODEL_EVIDENCE, rejection: null }

function decide(vlmResult: Parameters<typeof decideBiometricAttempt>[0]["vlmResult"], faceComparison: Parameters<typeof decideBiometricAttempt>[0]["faceComparison"]) {
  return decideBiometricAttempt({
    vlmResult,
    faceComparison,
    preparationRejection: null,
    subject,
    subjectFingerprint: biometricSubjectFingerprint(subject),
    idDocument,
  })
}

/**
 * The same-person signal every completed attempt carries, so a failure path
 * that writes no provider result cannot drop an adverse verdict.
 */
describe("decideBiometricAttempt: faceVerdict", () => {
  it("records a passing verdict on a pass", () => {
    const decision = decide(reply(), passingComparison)
    expect(decision.biometricPassed).toBe(true)
    expect(decision.faceVerdict).toEqual({ samePerson: "same", faceMatch: true, faceModelSamePerson: true })
  })

  it("keeps a 'different' verdict when the liveness gate leaves no provider result", () => {
    const decision = decide(reply({ isLive: false, samePerson: "different", faceMatch: false, matchConfidence: 0.08 }), passingComparison)
    expect(decision.biometricResult).toBeNull()
    expect(decision.biometricFailureReason).toBe("vlm_liveness_failed")
    expect(decision.faceVerdict).toEqual({ samePerson: "different", faceMatch: false, faceModelSamePerson: true })
  })

  it("keeps the VLM verdict when the face model refused before comparing", () => {
    const decision = decide(reply({ samePerson: "different", faceMatch: false, matchConfidence: 0.08 }), {
      ok: false,
      rejection: { reason: "face_count_invalid", message: "Two faces in the selfie" },
      idFaceCount: 1,
      selfieFaceCount: 2,
    })
    expect(decision.biometricResult).toBeNull()
    expect(decision.faceVerdict).toEqual({ samePerson: "different", faceMatch: false, faceModelSamePerson: null })
  })

  it("records the face model's own refusal", () => {
    const decision = decide(reply(), {
      ok: true,
      evidence: { ...PASSING_FACE_MODEL_EVIDENCE, samePerson: false },
      rejection: { reason: "match_score_below_threshold", message: "Face comparison similarity below threshold" },
    })
    expect(decision.faceVerdict).toEqual({ samePerson: "same", faceMatch: true, faceModelSamePerson: false })
  })

  it("records nothing when neither judge answered", () => {
    expect(decide({ ok: false, error: "upstream unavailable" }, null).faceVerdict).toBeNull()
    expect(decide({ ok: false, error: "AI document extraction is not configured" }, null).faceVerdict).toBeNull()
  })
})
