import { describe, expect, it } from "vitest"
import {
  BENIGN_CAPTURE_REASONS,
  BIOMETRIC_FAILURE_REASON_CLASS,
  assessBiometricEvidence,
  assessVlmBiometricExtraction,
  isAdversePriorAttempt,
  biometricSubjectFingerprint,
  parseBiometricEvidenceFailureReason,
  type BiometricDocumentEvidence,
} from "./biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "./face-model/evidence.test-helpers"
import { BIOMETRIC_FAILURE_COPY } from "./biometric-failure-copy"

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
// The v3 verdict a pass must carry: the VLM gates and the face model.
const passingVlmVerdict = {
  provider: "vlm-face-match-v3",
  idPhotoKind: "photograph",
  idPhotoIsRealPhotograph: true,
  idPhotoFaceDetected: true,
  selfieIsRealPhotograph: true,
  samePerson: "same",
  faceMatch: true,
  matchConfidence: 0.98,
  livenessConfidence: 0.97,
  faceModel: PASSING_FACE_MODEL_EVIDENCE,
}
// The client's newest verified ID copy, which the match was run against.
const idDocument = { id: "id-doc-1", contentSha256: "c".repeat(64) }
// The client's non-deleted ID copies.
const idCopyCreatedAt = new Date("2026-07-20T08:00:00.000Z")
const idDocumentCopies = [{ ...idDocument, verified: true, verificationRejectedAt: null, verificationRejectedById: null, createdAt: idCopyCreatedAt }]
const boundProviderResult = {
  ...passingProviderResult,
  ...passingVlmVerdict,
  idDocumentId: idDocument.id,
  idDocumentSha256: idDocument.contentSha256,
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
    expect(assessBiometricEvidence(passingEvidence, { subject, idDocument, idDocumentCopies })).toEqual({ ok: true })
  })

  it("can assess provider evidence before the document acceptance write", () => {
    expect(assessBiometricEvidence(
      { ...passingEvidence, verified: false },
      { subject, idDocument, idDocumentCopies, requireDocumentVerified: false },
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
    expect(assessBiometricEvidence({ ...passingEvidence, ...changes }, { subject, idDocument, idDocumentCopies })).toEqual({
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
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "face_not_detected" })
  })

  it("does not trust an unknown persisted failure reason", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      verified: false,
      extractionStatus: "failed",
      extractionResult: null,
      biometricResult: { biometricFailureReason: "staff_says_ok" },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "extraction_incomplete" })
  })

  it.each([
    ["extractionResult"],
    ["validationScore"],
    ["biometricMatchScore"],
    ["biometricLiveness"],
  ] as const)("fails closed when %s is absent", (field) => {
    expect(assessBiometricEvidence({ ...passingEvidence, [field]: null }, { subject, idDocument, idDocumentCopies })).toEqual({
      ok: false,
      reason: "biometric_evidence_missing",
    })
  })

  it("gives the VLM-unavailable marker no exemption from the v2 verdict", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      extractionResult: { vlmUnavailable: true },
      biometricResult: {
        ...passingProviderResult,
        idDocumentId: idDocument.id,
        idDocumentSha256: idDocument.contentSha256,
        subjectFingerprint: biometricSubjectFingerprint(subject),
      },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "provider_verification_missing" })
  })

  it.each([
    ["matchConfidence", 0.6951, "match_score_below_threshold"],
    ["livenessConfidence", 0.6951, "liveness_score_below_threshold"],
    ["matchConfidence", undefined, "provider_verification_failed"],
    ["livenessConfidence", "0.97", "provider_verification_failed"],
    ["matchConfidence", Number.NaN, "provider_verification_failed"],
  ])("re-checks the raw confidence: %s %s refuses as %s", (field, value, reason) => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, [field]: value },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason })
  })

  it.each([
    ["matchConfidence", 1.0001],
    ["livenessConfidence", 1.0001],
    ["matchConfidence", 95],
    ["livenessConfidence", 95],
  ])("refuses a raw %s of %s, outside 0..1", (field, value) => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, [field]: value },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "provider_verification_failed" })
  })

  it("accepts raw confidences of exactly 1", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, matchConfidence: 1, livenessConfidence: 1 },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: true })
  })

  it("accepts raw confidences exactly at the threshold", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, matchConfidence: 0.7, livenessConfidence: 0.7 },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: true })
  })

  // v1 passed a selfie against a silhouette placeholder, and v2 let the VLM
  // decide same-person (it said "same" against placeholder cards): neither
  // verifies.
  it.each([
    ["v1 VLM evidence", "vlm-face-match-v1"],
    ["v2 VLM evidence", "vlm-face-match-v2"],
    ["untagged VLM evidence", undefined],
    ["an unknown provider", "smile-identity"],
  ])("does not count %s as verified", (_label, provider) => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, provider },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "provider_verification_missing" })
  })

  it.each([
    ["idPhotoKind", "silhouette_placeholder"],
    ["idPhotoKind", undefined],
    ["idPhotoIsRealPhotograph", false],
    ["idPhotoIsRealPhotograph", "true"],
    ["idPhotoFaceDetected", false],
    ["selfieIsRealPhotograph", false],
    ["samePerson", "uncertain"],
    ["faceMatch", false],
  ])("refuses verified v3 evidence whose %s is %s", (field, value) => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, [field]: value },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "provider_verification_failed" })
  })

  it("refuses v2-shaped evidence relabelled v3 without the face model's result", () => {
    const { faceModel: _faceModel, ...withoutModel } = boundProviderResult
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: withoutModel,
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "provider_verification_failed" })
  })

  // The VLM's "same" at full confidence cannot carry a face model that did
  // not confirm the match, however the stored fields were edited.
  it.each([
    ["a similarity below the threshold", { similarity: 0.2 }, "match_score_below_threshold"],
    ["a similarity just below the threshold", { similarity: 0.36299999999999993 }, "match_score_below_threshold"],
    ["samePerson false", { samePerson: false }, "provider_verification_failed"],
    ["a lowered threshold", { threshold: 0.1, similarity: 0.2 }, "provider_verification_failed"],
    ["a tampered detector checksum", { detectorSha256: "f".repeat(64) }, "provider_verification_failed"],
    ["a tampered recognizer checksum", { recognizerSha256: "f".repeat(64) }, "provider_verification_failed"],
    ["two selfie faces", { selfieFaceCount: 2 }, "provider_verification_failed"],
    ["no ID face", { idFaceCount: 0 }, "provider_verification_failed"],
    ["two comparable ID faces", { idFaceCount: 2, idSecondFaceAreaRatio: 0.9 }, "provider_verification_failed"],
    ["a non-numeric similarity", { similarity: "0.9" }, "provider_verification_failed"],
  ])("refuses verified v3 evidence with %s", (_label, change, reason) => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, faceModel: { ...PASSING_FACE_MODEL_EVIDENCE, ...change } },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason })
  })

  it("accepts a similarity exactly at the threshold and a small ghost face on the ID", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: {
        ...boundProviderResult,
        faceModel: { ...PASSING_FACE_MODEL_EVIDENCE, similarity: 0.363, idFaceCount: 2, idSecondFaceAreaRatio: 0.1 },
      },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: true })
  })

  it("does not treat an arbitrary extraction error as the configured VLM exception", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      extractionResult: null,
      extractionError: "VLM timed out after dispatch",
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "biometric_evidence_missing" })
  })

  it("fails closed when successful provider evidence has no subject binding", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: passingProviderResult,
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "subject_fingerprint_missing" })
  })

  it("rejects a synthetic provider success even when every score passes", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, simulated: true },
    }, { subject, idDocument, idDocumentCopies })).toEqual({
      ok: false,
      reason: "simulated_provider_evidence",
    })
  })

  it("rejects provider evidence after the client identity changes", () => {
    expect(assessBiometricEvidence(passingEvidence, {
      subject: { ...subject, idNumber: "9101015009086" },
      idDocument,
      idDocumentCopies,
    })).toEqual({ ok: false, reason: "subject_identity_changed" })
  })

  // The match ran against id-doc-1; staff have since verified a newer id-doc-2.
  const newerVerified = { id: "id-doc-2", contentSha256: "d".repeat(64) }
  const supersededCopy = { ...idDocument, verified: true, verificationRejectedAt: null, verificationRejectedById: null, createdAt: idCopyCreatedAt }
  const newerVerifiedCopy = { ...newerVerified, verified: true, verificationRejectedAt: null, verificationRejectedById: null, createdAt: new Date("2026-07-21T08:00:00.000Z") }

  it("marks a match against a superseded verified copy as a pending ID change", () => {
    expect(assessBiometricEvidence(passingEvidence, {
      subject,
      idDocument: newerVerified,
      idDocumentCopies: [supersededCopy, newerVerifiedCopy],
    })).toEqual({ ok: false, reason: "subject_identity_changed", idDocumentNotCurrent: true })
  })

  it.each([
    ["the matched copy was never verified and a newer copy is", newerVerified, [{ ...supersededCopy, verified: false }, newerVerifiedCopy]],
    ["staff rejected it (verificationRejectedAt)", newerVerified, [{ ...supersededCopy, verificationRejectedAt: new Date("2026-10-12T09:00:00.000Z") }]],
    ["a named reviewer rejected it (verificationRejectedById)", newerVerified, [{ ...supersededCopy, verificationRejectedById: "officer-1" }]],
    ["it was deleted (absent from the non-deleted copies)", newerVerified, []],
    ["its bytes are not the ones matched", newerVerified, [{ ...supersededCopy, contentSha256: "e".repeat(64) }]],
    ["the caller did not read the copies", newerVerified, null],
    ["the client has no verified ID copy", null, [supersededCopy]],
    ["the matched copy is itself the newest verified one", { id: "id-doc-1", contentSha256: "d".repeat(64) }, [supersededCopy]],
  ] as const)("keeps a binding refusal a failed attempt when %s", (_label, current, copies) => {
    expect(assessBiometricEvidence(passingEvidence, {
      subject,
      idDocument: current,
      idDocumentCopies: copies,
    })).toEqual({ ok: false, reason: "subject_identity_changed" })
  })

  it.each([
    ["a score below the threshold", { biometricMatchScore: 69 }, "match_score_below_threshold"],
    ["an unverified selfie document", { verified: false }, "document_not_verified"],
    ["a refusing verdict", { biometricResult: { ...boundProviderResult, faceMatch: false } }, "provider_verification_failed"],
  ] as const)("names the other refusal, not the ID change, when the binding also fails: %s", (_label, change, reason) => {
    expect(assessBiometricEvidence({ ...passingEvidence, ...change }, {
      subject,
      idDocument: { id: "id-doc-2", contentSha256: "d".repeat(64) },
      idDocumentCopies,
    })).toEqual({ ok: false, reason })
  })

  it("does not mark a fingerprint mismatch as a pending ID change", () => {
    expect(assessBiometricEvidence(passingEvidence, {
      subject: { ...subject, firstName: "Changed" },
      idDocument: { id: "id-doc-2", contentSha256: "d".repeat(64) },
      idDocumentCopies,
    })).toEqual({ ok: false, reason: "subject_identity_changed" })
  })

  it("refuses a match whose evidence names no digest, against a copy without one", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, idDocumentSha256: null },
    }, {
      subject,
      idDocument: newerVerified,
      idDocumentCopies: [{ ...supersededCopy, contentSha256: null }],
    })).toEqual({
      // No digest to bind to: not a pending ID change.
      ok: false,
      reason: "subject_identity_changed",
    })
  })

  describe("a match against the client's first ID copy, not yet verified", () => {
    // No verified ID copy on file; the borrower uploads B and takes the
    // selfie before staff review B. Capture compares against B, the newest
    // copy that is neither deleted nor rejected.
    const verifiedA = {
      id: "id-doc-A", contentSha256: "a".repeat(64), verified: true,
      verificationRejectedAt: null, verificationRejectedById: null,
      createdAt: new Date("2026-07-20T08:00:00.000Z"),
    }
    const currentB = {
      id: "id-doc-B", contentSha256: "b".repeat(64), verified: false,
      verificationRejectedAt: null, verificationRejectedById: null,
      createdAt: new Date("2026-07-21T08:00:00.000Z"),
    }
    const boundToB: BiometricDocumentEvidence = {
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, idDocumentId: currentB.id, idDocumentSha256: currentB.contentSha256 },
    }
    const awaiting = { ok: false, reason: "subject_identity_changed", idDocumentAwaitingVerification: true }
    const failed = { ok: false, reason: "subject_identity_changed" }

    it("marks it awaiting ID verification when the client has no verified ID copy", () => {
      expect(assessBiometricEvidence(boundToB, {
        subject, idDocument: null, priorAdverseAttempt: false, idDocumentCopies: [currentB],
      })).toEqual(awaiting)
      // An older copy, unverified too, changes nothing: B is the current one.
      expect(assessBiometricEvidence(boundToB, {
        subject, idDocument: null, priorAdverseAttempt: false,
        idDocumentCopies: [{ ...currentB, id: "id-doc-older", contentSha256: "c".repeat(64), createdAt: verifiedA.createdAt }, currentB],
      })).toEqual(awaiting)
    })

    it("keeps it a failed attempt while a verified copy A is on file (the L1 substitute pattern)", () => {
      expect(assessBiometricEvidence(boundToB, {
        subject,
        idDocument: { id: verifiedA.id, contentSha256: verifiedA.contentSha256 },
        idDocumentCopies: [verifiedA, currentB],
        priorAdverseAttempt: false,
      })).toEqual(failed)
    })

    it.each([
      ["an earlier attempt returned an adverse face result", true],
      ["the caller did not read the earlier attempts", undefined],
    ] as const)("keeps it a failed attempt when %s", (_label, priorAdverseAttempt) => {
      expect(assessBiometricEvidence(boundToB, {
        subject, idDocument: null, idDocumentCopies: [currentB], priorAdverseAttempt,
      })).toEqual(failed)
    })

    it.each([
      ["staff rejected B (verificationRejectedAt)", [{ ...currentB, verificationRejectedAt: new Date("2026-07-22T08:00:00.000Z") }]],
      ["a named reviewer rejected B (verificationRejectedById)", [{ ...currentB, verificationRejectedById: "officer-1" }]],
      ["B was deleted (absent from the non-deleted copies)", []],
      ["B's stored digest is not the one matched", [{ ...currentB, contentSha256: "e".repeat(64) }]],
      ["B has no usable digest", [{ ...currentB, contentSha256: "not-a-digest" }]],
      ["a later upload C buried B unreviewed", [currentB, { ...currentB, id: "id-doc-C", contentSha256: "f".repeat(64), createdAt: new Date("2026-07-22T08:00:00.000Z") }]],
      ["C, written in the same instant, sorts after B by id", [currentB, { ...currentB, id: "id-doc-C", contentSha256: "f".repeat(64) }]],
      ["the caller did not read the copies", null],
    ] as const)("keeps it a failed attempt when %s", (_label, copies) => {
      expect(assessBiometricEvidence(boundToB, {
        subject, idDocument: null, priorAdverseAttempt: false, idDocumentCopies: copies,
      })).toEqual(failed)
    })

    it("keeps it a failed attempt when neither the match nor B carries a digest", () => {
      expect(assessBiometricEvidence({
        ...boundToB,
        biometricResult: { ...boundProviderResult, idDocumentId: currentB.id, idDocumentSha256: null },
      }, { subject, idDocument: null, priorAdverseAttempt: false, idDocumentCopies: [{ ...currentB, contentSha256: null }] })).toEqual(failed)
    })

    it("keeps it a failed attempt when the match names another client's copy", () => {
      // The copies are this client's; a row id outside them is not current.
      expect(assessBiometricEvidence({
        ...boundToB,
        biometricResult: { ...boundProviderResult, idDocumentId: "other-client-id-copy", idDocumentSha256: currentB.contentSha256 },
      }, { subject, idDocument: null, priorAdverseAttempt: false, idDocumentCopies: [currentB] })).toEqual(failed)
    })

    it("names the other refusal when B's match also fails a check", () => {
      expect(assessBiometricEvidence({ ...boundToB, biometricMatchScore: 69 }, {
        subject, idDocument: null, priorAdverseAttempt: false, idDocumentCopies: [currentB],
      })).toEqual({ ok: false, reason: "match_score_below_threshold" })
    })

    it("does not mark a fingerprint mismatch against B as awaiting", () => {
      expect(assessBiometricEvidence(boundToB, {
        subject: { ...subject, lastName: "Changed" }, idDocument: null, priorAdverseAttempt: false, idDocumentCopies: [currentB],
      })).toEqual(failed)
    })

    it("passes once staff verify B, the newest verified copy", () => {
      expect(assessBiometricEvidence(boundToB, {
        subject,
        idDocument: { id: currentB.id, contentSha256: currentB.contentSha256 },
        idDocumentCopies: [{ ...currentB, verified: true }],
      })).toEqual({ ok: true })
    })
  })

  it.each([
    ["the string \"true\"", "true"],
    ["1", 1],
    ["null", null],
    ["the string \"false\"", "false"],
  ])("rejects simulated provider evidence marked %s", (_label, simulated) => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, simulated },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: false, reason: "simulated_provider_evidence" })
  })

  it("accepts simulated: false", () => {
    expect(assessBiometricEvidence({
      ...passingEvidence,
      biometricResult: { ...boundProviderResult, simulated: false },
    }, { subject, idDocument, idDocumentCopies })).toEqual({ ok: true })
  })
})

describe("parseBiometricEvidenceFailureReason", () => {
  it("accepts only known fail-closed reason values", () => {
    expect(parseBiometricEvidenceFailureReason("vlm_liveness_failed")).toBe(
      "vlm_liveness_failed",
    )
    for (const reason of ["id_document_portrait_invalid", "selfie_not_real_photograph"]) {
      expect(parseBiometricEvidenceFailureReason(reason)).toBe(reason)
    }
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

  // PostgreSQL's trim() strips spaces only; subject_has_composite_kyc refused these.
  it.each(["good\n", "\tpoor", "good\r", "\u00a0good"])("refuses quality %j", (quality) => {
    expect(assessVlmBiometricExtraction({
      ...passingExtractionResult,
      quality: { value: quality },
    })).toEqual({ ok: false, reason: "biometric_evidence_missing" })
  })

  it("rejects a string face count instead of coercing it", () => {
    expect(assessVlmBiometricExtraction({
      ...passingExtractionResult,
      facesCount: { value: "1" },
    })).toEqual({ ok: false, reason: "face_count_invalid" })
  })
})

describe("isAdversePriorAttempt", () => {
  const failed = (biometricFailureReason: unknown) => ({
    extractionStatus: "failed",
    biometricResult: { biometricFailureReason },
  })

  it("classifies every reason in the failure registry, so a new one cannot land benign by omission", () => {
    // BIOMETRIC_FAILURE_COPY is keyed by the full BiometricEvidenceFailureReason
    // union; the class map is too, and must cover exactly the same reasons.
    expect(Object.keys(BIOMETRIC_FAILURE_REASON_CLASS).sort()).toEqual(Object.keys(BIOMETRIC_FAILURE_COPY).sort())
    for (const reason of Object.keys(BIOMETRIC_FAILURE_COPY)) {
      expect(parseBiometricEvidenceFailureReason(reason)).toBe(reason)
      expect(["benign_capture", "adverse"]).toContain(
        BIOMETRIC_FAILURE_REASON_CLASS[reason as keyof typeof BIOMETRIC_FAILURE_REASON_CLASS],
      )
      expect(isAdversePriorAttempt(failed(reason))).toBe(
        BIOMETRIC_FAILURE_REASON_CLASS[reason as keyof typeof BIOMETRIC_FAILURE_REASON_CLASS] === "adverse",
      )
    }
  })

  it("treats only capture and transport problems as benign", () => {
    expect([...BENIGN_CAPTURE_REASONS].sort()).toEqual([
      "extraction_incomplete",
      "face_count_invalid",
      "face_not_detected",
      "image_unusable",
      // Written only over an attempt that PASSED, when a newer selfie landed
      // while it ran (lib/kyc/selfie-biometric.server.ts).
      "superseded_biometric_evidence",
    ])
  })

  it.each([
    "match_score_below_threshold",
    "provider_verification_failed",
    "id_document_portrait_invalid",
    "selfie_not_real_photograph",
    "vlm_liveness_failed",
    "liveness_score_below_threshold",
    "subject_identity_changed",
    "subject_fingerprint_missing",
    "validation_mismatch",
  ])("counts a failed attempt recording %s as adverse", (reason) => {
    expect(isAdversePriorAttempt(failed(reason))).toBe(true)
  })

  it.each([
    ["no reason", { extractionStatus: "failed", biometricResult: { ok: false } }],
    ["a null reason", failed(null)],
    ["an unknown reason", failed("a_reason_added_later")],
    ["a non-string reason", failed(7)],
    ["no result at all", { extractionStatus: "failed", biometricResult: null }],
    ["a skipped attempt with no reason", { extractionStatus: "skipped", biometricResult: null }],
  ] as const)("counts a failed attempt with %s as adverse", (_label, row) => {
    expect(isAdversePriorAttempt(row)).toBe(true)
  })

  it.each(["face_not_detected", "face_count_invalid", "image_unusable", "extraction_incomplete"])(
    "does not count a failed attempt recording %s", (reason) => {
      expect(isAdversePriorAttempt(failed(reason))).toBe(false)
    },
  )

  it("counts a selfie staff rejected as adverse, whatever its check said", () => {
    expect(isAdversePriorAttempt({
      extractionStatus: "done", biometricResult: { biometricFailureReason: null },
      verificationRejectedAt: new Date("2026-07-22T08:00:00.000Z"), verificationRejectedById: "officer-1",
    })).toBe(true)
    expect(isAdversePriorAttempt({
      extractionStatus: "done", biometricResult: null, verificationRejectedById: "officer-1",
    })).toBe(true)
  })

  it.each([
    ["passed", "done"],
    ["still processing", "processing"],
    ["pending", "pending"],
  ])("does not count an attempt that %s", (_label, extractionStatus) => {
    expect(isAdversePriorAttempt({ extractionStatus, biometricResult: { biometricFailureReason: null } })).toBe(false)
  })

  it("does not count a document that is not a selfie", () => {
    expect(isAdversePriorAttempt({ docType: "ID_COPY", ...failed("provider_verification_failed") })).toBe(false)
  })
})
