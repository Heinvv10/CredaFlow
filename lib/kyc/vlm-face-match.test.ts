import { describe, expect, it } from "vitest"
import { readVlmFaceMatchVerdict } from "./vlm-face-match"

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
})
