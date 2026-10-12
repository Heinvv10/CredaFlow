import { describe, expect, it } from "vitest"
import { readVlmFaceMatchSideRejection, readVlmFaceMatchVerdict } from "./vlm-face-match"
import { isManualKycExceptionableFailureReason } from "./manual-exception-policy"

// A mocked VLM extraction (ExtractedFields shape: { field: { value } }).
const fullVerdict = {
  faceDetected: { value: true },
  facesCount: { value: 1 },
  isLive: { value: true },
  quality: { value: "good" },
  livenessConfidence: { value: 0.97 },
  idPhotoKind: { value: "photograph" },
  idPhotoIsRealPhotograph: { value: true },
  idPhotoFaceDetected: { value: true },
  selfieIsRealPhotograph: { value: true },
  samePerson: { value: "same" },
  faceMatch: { value: true },
  matchConfidence: { value: 0.95 },
}

describe("readVlmFaceMatchVerdict", () => {
  it("passes only a real photograph of the same person, scaling confidences to 0–100", () => {
    expect(readVlmFaceMatchVerdict(fullVerdict)).toEqual({
      faceMatch: true,
      idPhotoFaceDetected: true,
      idPhotoKind: "photograph",
      idPhotoIsRealPhotograph: true,
      selfieIsRealPhotograph: true,
      samePerson: "same",
      matchScore: 95,
      livenessScore: 97,
      matchConfidence: 0.95,
      livenessConfidence: 0.97,
      rejection: null,
    })
  })

  // The 2026-10-10 failure: the model said faceMatch=true / idPhotoFaceDetected
  // =true at 0.85 against a grey silhouette. The kind gate must refuse it even
  // when every other judgement is optimistic.
  it.each(["silhouette_placeholder", "illustration", "blank_or_missing", "obscured", "other"])(
    "refuses an ID portrait of kind %s even when the model claims a match",
    (kind) => {
      const verdict = readVlmFaceMatchVerdict({ ...fullVerdict, idPhotoKind: { value: kind } })
      expect(verdict?.rejection).toEqual({
        reason: "id_document_portrait_invalid",
        message: `ID document portrait is not a photograph (${kind})`,
      })
    },
  )

  // ID-side and selfie-side refusals carry reasons that are NOT on the manual
  // exception allow-list; a mismatch between two real faces stays generic.
  it.each([
    ["ID photo not a real photograph", { idPhotoIsRealPhotograph: { value: false } }, "id_document_portrait_invalid"],
    ["no face in the ID photo", { idPhotoFaceDetected: { value: false } }, "id_document_portrait_invalid"],
    ["selfie not a real photograph", { selfieIsRealPhotograph: { value: false } }, "selfie_not_real_photograph"],
    ["samePerson uncertain", { samePerson: { value: "uncertain" } }, "provider_verification_failed"],
    ["samePerson different", { samePerson: { value: "different" } }, "provider_verification_failed"],
    ["faceMatch false", { faceMatch: { value: false } }, "provider_verification_failed"],
    ["samePerson same but faceMatch false (contradiction)", { faceMatch: { value: false }, samePerson: { value: "same" } }, "provider_verification_failed"],
  ])("refuses when %s", (_label, change, reason) => {
    const verdict = readVlmFaceMatchVerdict({ ...fullVerdict, ...change })
    expect(verdict).not.toBeNull()
    expect(verdict?.rejection?.reason).toBe(reason)
  })

  it("names the ID side, not the selfie, when both sides are refused", () => {
    expect(readVlmFaceMatchVerdict({
      ...fullVerdict,
      idPhotoKind: { value: "illustration" },
      selfieIsRealPhotograph: { value: false },
    })?.rejection?.reason).toBe("id_document_portrait_invalid")
  })

  it.each([
    ["match confidence", { matchConfidence: { value: 0.69 } }, "match_score_below_threshold", "Face match confidence below threshold"],
    ["liveness confidence", { livenessConfidence: { value: 0.5 } }, "liveness_score_below_threshold", "Liveness confidence below threshold"],
  ])("refuses low %s", (_label, change, reason, message) => {
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, ...change })?.rejection).toEqual({ reason, message })
  })

  it("accepts a confidence exactly at the threshold", () => {
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, matchConfidence: { value: 0.7 } })?.rejection).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, livenessConfidence: { value: 0.7 } })?.rejection).toBeNull()
  })

  // 0.6951 rounds to a displayed 70; the gate must judge the raw value.
  it.each([
    ["match", { matchConfidence: { value: 0.6951 } }, "match_score_below_threshold"],
    ["liveness", { livenessConfidence: { value: 0.6951 } }, "liveness_score_below_threshold"],
  ])("does not round a %s confidence just under the threshold up to a pass", (_label, change, reason) => {
    const verdict = readVlmFaceMatchVerdict({ ...fullVerdict, ...change })
    expect(verdict?.rejection?.reason).toBe(reason)
  })

  it("normalises case and whitespace on the enums but rejects unknown values", () => {
    expect(readVlmFaceMatchVerdict({
      ...fullVerdict,
      idPhotoKind: { value: " Photograph " },
      samePerson: { value: "SAME" },
    })?.rejection).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, idPhotoKind: { value: "photo" } })).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, samePerson: { value: "yes" } })).toBeNull()
  })

  it.each([
    "idPhotoKind",
    "idPhotoIsRealPhotograph",
    "idPhotoFaceDetected",
    "selfieIsRealPhotograph",
    "samePerson",
    "faceMatch",
    "matchConfidence",
    "livenessConfidence",
  ])("fails closed (null) when %s is missing", (field) => {
    const partial: Record<string, unknown> = { ...fullVerdict }
    delete partial[field]
    expect(readVlmFaceMatchVerdict(partial)).toBeNull()
  })

  it("returns null — never a partial verdict — when any field is malformed", () => {
    expect(readVlmFaceMatchVerdict(null)).toBeNull()
    expect(readVlmFaceMatchVerdict([])).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, faceMatch: { value: "yes" } })).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, idPhotoIsRealPhotograph: { value: "true" } })).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, selfieIsRealPhotograph: { value: 1 } })).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, matchConfidence: { value: "0.95" } })).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, matchConfidence: { value: 1.5 } })).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, matchConfidence: { value: -0.1 } })).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, matchConfidence: { value: Number.NaN } })).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, livenessConfidence: {} })).toBeNull()
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, idPhotoFaceDetected: { value: 1 } })).toBeNull()
  })

  it("keeps a truthful no-match verdict readable", () => {
    expect(readVlmFaceMatchVerdict({
      ...fullVerdict,
      samePerson: { value: "different" },
      faceMatch: { value: false },
      matchConfidence: { value: 0.1 },
    })).toEqual(expect.objectContaining({
      faceMatch: false,
      samePerson: "different",
      matchScore: 10,
      livenessScore: 97,
      rejection: {
        reason: "provider_verification_failed",
        message: "VLM face match did not confirm the selfie against the ID photograph",
      },
    }))
  })

  it.each([
    ["exactly 1", 1, true],
    ["1.0001", 1.0001, false],
    ["95 (a percentage)", 95, false],
  ])("bounds a raw confidence of %s to 0..1", (_label, value, readable) => {
    for (const field of ["matchConfidence", "livenessConfidence"]) {
      const verdict = readVlmFaceMatchVerdict({ ...fullVerdict, [field]: { value } })
      expect(verdict === null).toBe(!readable)
    }
  })
})

describe("readVlmFaceMatchSideRejection", () => {
  it("finds no side refusal in a real photo pair, whatever else is malformed", () => {
    expect(readVlmFaceMatchSideRejection(fullVerdict)).toBeNull()
    expect(readVlmFaceMatchSideRejection({ ...fullVerdict, matchConfidence: { value: 10 } })).toBeNull()
    expect(readVlmFaceMatchSideRejection({ ...fullVerdict, samePerson: undefined })).toBeNull()
  })

  const UNREADABLE_ID = "ID document portrait could not be verified: the check's answer about it was unreadable"
  const UNREADABLE_SELFIE = "Selfie could not be verified as a real photograph: the check's answer about it was unreadable"

  it.each([
    ["a known non-photograph kind", "silhouette_placeholder", "silhouette_placeholder", "ID document portrait is not a photograph (silhouette_placeholder)"],
    ["a kind needing normalisation", " Silhouette_Placeholder ", "silhouette_placeholder", "ID document portrait is not a photograph (silhouette_placeholder)"],
    ["an unknown kind", "grey_avatar", "unrecognised", UNREADABLE_ID],
    ["an unknown kind with spaces", "Silhouette Placeholder", "unrecognised", UNREADABLE_ID],
    ["a non-string kind", 3, "unrecognised", UNREADABLE_ID],
    ["a nested kind", { value: "photograph" }, "unrecognised", UNREADABLE_ID],
  ])("refuses %s on the kind alone", (_label, kind, recorded, message) => {
    // Both booleans say "real photograph": only the kind refuses.
    expect(readVlmFaceMatchSideRejection({ ...fullVerdict, idPhotoKind: { value: kind } })).toEqual({
      reason: "id_document_portrait_invalid",
      message,
      judgement: {
        idPhotoKind: recorded,
        idPhotoIsRealPhotograph: true,
        idPhotoFaceDetected: true,
        selfieIsRealPhotograph: true,
      },
    })
  })

  it("accepts the photograph kind after the strict parser's normalisation", () => {
    expect(readVlmFaceMatchSideRejection({ ...fullVerdict, idPhotoKind: { value: " PHOTOGRAPH " } })).toBeNull()
  })

  it.each([
    ["idPhotoIsRealPhotograph false", { idPhotoIsRealPhotograph: { value: false } }, "id_document_portrait_invalid"],
    ["idPhotoFaceDetected false", { idPhotoFaceDetected: { value: false } }, "id_document_portrait_invalid"],
    ["selfieIsRealPhotograph false", { selfieIsRealPhotograph: { value: false } }, "selfie_not_real_photograph"],
    ["both sides refused", { idPhotoKind: { value: "illustration" }, selfieIsRealPhotograph: { value: false } }, "id_document_portrait_invalid"],
  ])("refuses on %s", (_label, change, reason) => {
    expect(readVlmFaceMatchSideRejection({ ...fullVerdict, ...change })?.reason).toBe(reason)
  })

  // An answer that leaves a side unjudged refuses: mapExtractedFields drops a
  // null or "" value, so the model answering null for every ID judgement
  // looked like silence, and a liveness failure beside it was recorded under
  // an exceptionable reason over a portrait nobody judged.
  const NO_ANSWER_ID = "ID document portrait could not be verified: the check gave no answer about it"
  const NO_ANSWER_SELFIE = "Selfie could not be verified as a real photograph: the check gave no answer about it"
  it.each([
    ["idPhotoKind", "id_document_portrait_invalid", NO_ANSWER_ID],
    ["idPhotoIsRealPhotograph", "id_document_portrait_invalid", NO_ANSWER_ID],
    ["idPhotoFaceDetected", "id_document_portrait_invalid", NO_ANSWER_ID],
    ["selfieIsRealPhotograph", "selfie_not_real_photograph", NO_ANSWER_SELFIE],
  ])("refuses an answer that leaves %s unjudged", (field, reason, message) => {
    for (const absent of [{ [field]: { value: null } }, { [field]: undefined }]) {
      const rejection = readVlmFaceMatchSideRejection({ ...fullVerdict, ...absent })
      expect(rejection?.reason).toBe(reason)
      expect(rejection?.message).toBe(message)
    }
  })

  // Judging neither photo is a fault in the check's reply, not in the ID: the
  // client is not told to upload a new ID, and no senior may except it.
  it.each([
    ["omitted", { faceDetected: { value: true }, isLive: { value: false } }],
    ["null", {
      faceDetected: { value: true },
      idPhotoKind: { value: null },
      idPhotoIsRealPhotograph: { value: null },
      idPhotoFaceDetected: { value: null },
      selfieIsRealPhotograph: { value: null },
    }],
  ])("records an answer whose side judgements are all %s as incomplete", (_label, extraction) => {
    expect(readVlmFaceMatchSideRejection(extraction)).toEqual({
      reason: "extraction_incomplete",
      message: "The face match check gave no answer about either photo",
      judgement: { idPhotoKind: null, idPhotoIsRealPhotograph: null, idPhotoFaceDetected: null, selfieIsRealPhotograph: null },
    })
    expect(isManualKycExceptionableFailureReason("extraction_incomplete")).toBe(false)
  })

  it("still refuses the ID portrait when only the selfie side was judged", () => {
    expect(readVlmFaceMatchSideRejection({ faceDetected: { value: true }, selfieIsRealPhotograph: { value: true } })).toEqual({
      reason: "id_document_portrait_invalid",
      message: NO_ANSWER_ID,
      judgement: { idPhotoKind: null, idPhotoIsRealPhotograph: null, idPhotoFaceDetected: null, selfieIsRealPhotograph: true },
    })
  })

  it("finds no side refusal when there is no answer to read", () => {
    expect(readVlmFaceMatchSideRejection(null)).toBeNull()
    expect(readVlmFaceMatchSideRejection([])).toBeNull()
    expect(readVlmFaceMatchSideRejection({ vlmUnavailable: true })).toBeNull()
  })

  // REPRO D: a present flag that is not exactly true read as absent, so a
  // silhouette ID or fake selfie fell through to an exceptionable reason.
  const { idPhotoKind: _k, idPhotoIsRealPhotograph: _r, idPhotoFaceDetected: _f, ...noIdSide } = fullVerdict
  it.each([
    ["idPhotoIsRealPhotograph \"false\", kind omitted", { ...noIdSide, idPhotoIsRealPhotograph: { value: "false" } },
      "id_document_portrait_invalid", UNREADABLE_ID,
      { idPhotoKind: null, idPhotoIsRealPhotograph: "unrecognised", idPhotoFaceDetected: null, selfieIsRealPhotograph: true }],
    ["idPhotoIsRealPhotograph nested false, kind omitted", { ...noIdSide, idPhotoIsRealPhotograph: { value: { value: false } } },
      "id_document_portrait_invalid", UNREADABLE_ID,
      { idPhotoKind: null, idPhotoIsRealPhotograph: "unrecognised", idPhotoFaceDetected: null, selfieIsRealPhotograph: true }],
    ["idPhotoFaceDetected 0, other ID flags omitted", { ...noIdSide, idPhotoFaceDetected: { value: 0 } },
      "id_document_portrait_invalid", UNREADABLE_ID,
      { idPhotoKind: null, idPhotoIsRealPhotograph: null, idPhotoFaceDetected: "unrecognised", selfieIsRealPhotograph: true }],
    ["selfieIsRealPhotograph 0", { ...fullVerdict, selfieIsRealPhotograph: { value: 0 } },
      "selfie_not_real_photograph", UNREADABLE_SELFIE,
      { idPhotoKind: "photograph", idPhotoIsRealPhotograph: true, idPhotoFaceDetected: true, selfieIsRealPhotograph: "unrecognised" }],
    ["selfieIsRealPhotograph \"false\"", { ...fullVerdict, selfieIsRealPhotograph: { value: "false" } },
      "selfie_not_real_photograph", UNREADABLE_SELFIE,
      { idPhotoKind: "photograph", idPhotoIsRealPhotograph: true, idPhotoFaceDetected: true, selfieIsRealPhotograph: "unrecognised" }],
    ["selfieIsRealPhotograph \"true\"", { ...fullVerdict, selfieIsRealPhotograph: { value: "true" } },
      "selfie_not_real_photograph", UNREADABLE_SELFIE,
      { idPhotoKind: "photograph", idPhotoIsRealPhotograph: true, idPhotoFaceDetected: true, selfieIsRealPhotograph: "unrecognised" }],
  ])("refuses a present side flag that is not exactly true: %s", (_label, extraction, reason, message, judgement) => {
    expect(readVlmFaceMatchSideRejection(extraction)).toEqual({ reason, message, judgement })
  })

  it("names an explicit ID judgement ahead of an unreadable one", () => {
    expect(readVlmFaceMatchSideRejection({
      ...fullVerdict,
      idPhotoKind: { value: "grey_avatar" },
      idPhotoFaceDetected: { value: false },
    })?.message).toBe("No face detected in the ID document photograph")
  })
})
