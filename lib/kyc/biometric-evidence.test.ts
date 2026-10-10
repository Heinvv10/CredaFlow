import { describe, expect, it } from "vitest"
import {
  assessBiometricEvidence,
  assessVlmBiometricExtraction,
  biometricSubjectFingerprint,
  parseBiometricEvidenceFailureReason,
  type BiometricDocumentEvidence,
} from "./biometric-evidence"

const subject = {
  id: "client-1",
  idNumber: "9001015009087",
  firstName: "Synthetic",
  lastName: "Customer",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
}

const passingExtractionResult = {
  faceDetected: { value: true },
  facesCount: { value: 1 },
  isLive: { value: true },
  quality: { value: "good" },
}
const passingProviderResult = {
  ok: true,
  verified: true,
  matchScore: 98,
  livenessScore: 97,
}
const boundProviderResult = {
  ...passingProviderResult,
  subjectFingerprint: biometricSubjectFingerprint(subject),
}
const passingEvidence: BiometricDocumentEvidence = {
  deletedAt: null,
  verified: true,
  extractionStatus: "done",
  extractionResult: passingExtractionResult,
  validationMismatch: false,
  validationScore: 98,
  biometricMatchScore: 98,
  biometricLiveness: 97,
  biometricVerifiedAt: new Date("2026-07-22T10:00:00.000Z"),
  biometricResult: boundProviderResult,
}

describe("biometricSubjectFingerprint", () => {
  it.each([
    [
      "ASCII identity",
      {
        id: "client-1",
        idNumber: "9001015009087",
        firstName: "Synthetic",
        lastName: "Customer",
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      },
      "d74c8d89499177e5610027e53ecbce4e755341b95f4aa5b0a55823be54af1aff",
    ],
    [
      "German sharp s",
      {
        id: "client-unicode-1",
        idNumber: "9001015009087",
        firstName: "Straße",
        lastName: "Mkhize",
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      },
      "edec45cb46fe3dee0da38f6cad20c74926496dc47908ec3bd52d2ab6709c88f5",
    ],
    [
      "Turkish and accented identity",
      {
        id: "client-unicode-2",
        idNumber: "ID-İ- 42",
        firstName: "İpek",
        lastName: "D’Ávila-Ndlovu",
        dateOfBirth: new Date("1988-12-03T00:00:00.000Z"),
      },
      "a0ba25ad7116f9755534d0781c8d555b46150349e86cb3345d9cd6887d961e75",
    ],
    [
      "decomposed combining marks",
      {
        id: "client-unicode-3",
        idNumber: "ID-03",
        firstName: "Jose\u0301",
        lastName: "N\u0303dlovu",
        dateOfBirth: null,
      },
      "7761793901bafc9b075a05fe82f53ab64494f7ffec89cbb5672e69c2a7acc877",
    ],
  ] as const)("uses the versioned byte contract for %s", (_label, value, expected) => {
    expect(biometricSubjectFingerprint(value)).toBe(expected)
  })

  it("invalidates even case-only or Unicode-normalization identity edits", () => {
    const original = biometricSubjectFingerprint({
      ...subject,
      firstName: "José",
    })

    expect(biometricSubjectFingerprint({
      ...subject,
      firstName: "JOSÉ",
    })).not.toBe(original)
    expect(biometricSubjectFingerprint({
      ...subject,
      firstName: "Jose\u0301",
    })).not.toBe(original)
  })
})

describe("assessBiometricEvidence", () => {
  it("accepts one live usable face with a completed positive provider result", () => {
    expect(assessBiometricEvidence(passingEvidence, { subject })).toEqual({ ok: true })
  })

  it("can assess provider evidence before the document acceptance write", () => {
    expect(assessBiometricEvidence(
      { ...passingEvidence, verified: false },
      { subject, requireDocumentVerified: false },
    )).toEqual({ ok: true })
  })

  it.each([
    ["extraction is incomplete", { extractionStatus: "failed" }, "extraction_incomplete"],
    ["no face was detected", { extractionResult: { ...passingExtractionResult, faceDetected: { value: false } } }, "face_not_detected"],
    ["there are no faces", { extractionResult: { ...passingExtractionResult, facesCount: { value: 0 } } }, "face_count_invalid"],
    ["there are multiple faces", { extractionResult: { ...passingExtractionResult, facesCount: { value: 2 } } }, "face_count_invalid"],
    ["liveness failed", { extractionResult: { ...passingExtractionResult, isLive: { value: false } } }, "vlm_liveness_failed"],
    ["image quality is unusable", { extractionResult: { ...passingExtractionResult, quality: { value: "unusable" } } }, "image_unusable"],
    ["validation mismatch is present", { validationMismatch: true }, "validation_mismatch"],
    ["validation score is too low", { validationScore: 69 }, "match_score_below_threshold"],
    ["provider match is too low", { biometricMatchScore: 69 }, "match_score_below_threshold"],
    ["provider liveness is too low", { biometricLiveness: 69 }, "liveness_score_below_threshold"],
    ["provider verification timestamp is missing", { biometricVerifiedAt: null }, "provider_verification_missing"],
    ["provider returned failure", { biometricResult: { ...boundProviderResult, ok: false } }, "provider_verification_failed"],
    ["provider did not verify", { biometricResult: { ...boundProviderResult, verified: false } }, "provider_verification_failed"],
    ["provider result is absent", { biometricResult: null }, "provider_verification_missing"],
    ["document was deleted", { deletedAt: new Date("2026-07-22T11:00:00.000Z") }, "document_deleted"],
    ["document was not accepted", { verified: false }, "document_not_verified"],
  ] as const)("rejects when %s", (_label, changes, reason) => {
    expect(assessBiometricEvidence({ ...passingEvidence, ...changes }, { subject })).toEqual({
      ok: false,
      reason,
    })
  })

  it("surfaces the producer's exact terminal biometric failure reason", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      verified: false,
      extractionStatus: "failed",
      extractionResult: null,
      biometricResult: { biometricFailureReason: "face_not_detected" },
    }, { subject })).toEqual({ ok: false, reason: "face_not_detected" })
  })

  it("does not trust an unknown persisted failure reason", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      verified: false,
      extractionStatus: "failed",
      extractionResult: null,
      biometricResult: { biometricFailureReason: "staff_says_ok" },
    }, { subject })).toEqual({ ok: false, reason: "extraction_incomplete" })
  })

  it.each([
    ["extractionResult"],
    ["validationScore"],
    ["biometricMatchScore"],
    ["biometricLiveness"],
  ] as const)("fails closed when %s is absent", (field) => {
    expect(assessBiometricEvidence({ ...passingEvidence, [field]: null }, { subject })).toEqual({
      ok: false,
      reason: "biometric_evidence_missing",
    })
  })

  it("accepts Smile Identity evidence when the persisted VLM-unavailable marker is present", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      extractionResult: { vlmUnavailable: true },
    }, { subject })).toEqual({ ok: true })
  })

  it("does not treat an arbitrary extraction error as the configured VLM exception", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      extractionResult: null,
      extractionError: "VLM timed out after dispatch",
    }, { subject })).toEqual({ ok: false, reason: "biometric_evidence_missing" })
  })

  it("fails closed when successful provider evidence has no subject binding", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: passingProviderResult,
    }, { subject })).toEqual({ ok: false, reason: "subject_fingerprint_missing" })
  })

  it("rejects a synthetic provider success even when every score passes", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, simulated: true },
    }, { subject })).toEqual({
      ok: false,
      reason: "simulated_provider_evidence",
    })
  })

  it("rejects provider evidence after the client identity changes", () => {
    expect(assessBiometricEvidence(passingEvidence, {
      subject: { ...subject, idNumber: "9101015009086" },
    })).toEqual({ ok: false, reason: "subject_identity_changed" })
  })
})

describe("parseBiometricEvidenceFailureReason", () => {
  it("accepts only known fail-closed reason values", () => {
    expect(parseBiometricEvidenceFailureReason("vlm_liveness_failed")).toBe(
      "vlm_liveness_failed",
    )
    expect(parseBiometricEvidenceFailureReason("bypass")).toBeNull()
    expect(parseBiometricEvidenceFailureReason(null)).toBeNull()
  })
})

describe("assessVlmBiometricExtraction", () => {
  it.each([
    ["uppercase unusable", "UNUSABLE", "image_unusable"],
    ["whitespace unusable", "  unusable  ", "image_unusable"],
    ["object quality", { label: "good" }, "biometric_evidence_missing"],
    ["unknown quality", "excellent", "biometric_evidence_missing"],
  ] as const)("fails closed for %s", (_label, quality, reason) => {
    expect(assessVlmBiometricExtraction({
      ...passingExtractionResult,
      quality: { value: quality },
    })).toEqual({ ok: false, reason })
  })

  it.each(["GOOD", " poor "])("normalizes known quality %s", (quality) => {
    expect(assessVlmBiometricExtraction({
      ...passingExtractionResult,
      quality: { value: quality },
    })).toEqual({ ok: true })
  })

  it("rejects a string face count instead of coercing it", () => {
    expect(assessVlmBiometricExtraction({
      ...passingExtractionResult,
      facesCount: { value: "1" },
    })).toEqual({ ok: false, reason: "face_count_invalid" })
  })
})
