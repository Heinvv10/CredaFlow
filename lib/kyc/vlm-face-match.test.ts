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
      expect(verdict?.rejection).toBe(`ID document portrait is not a photograph (${kind})`)
    },
  )

  it.each([
    ["ID photo not a real photograph", { idPhotoIsRealPhotograph: { value: false } }],
    ["no face in the ID photo", { idPhotoFaceDetected: { value: false } }],
    ["selfie not a real photograph", { selfieIsRealPhotograph: { value: false } }],
    ["samePerson uncertain", { samePerson: { value: "uncertain" } }],
    ["samePerson different", { samePerson: { value: "different" } }],
    ["faceMatch false", { faceMatch: { value: false } }],
    ["samePerson same but faceMatch false (contradiction)", { faceMatch: { value: false }, samePerson: { value: "same" } }],
  ])("refuses when %s", (_label, change) => {
    const verdict = readVlmFaceMatchVerdict({ ...fullVerdict, ...change })
    expect(verdict).not.toBeNull()
    expect(verdict?.rejection).not.toBeNull()
  })

  it.each([
    ["match confidence", { matchConfidence: { value: 0.69 } }, "Face match confidence below threshold"],
    ["liveness confidence", { livenessConfidence: { value: 0.5 } }, "Liveness confidence below threshold"],
  ])("refuses low %s", (_label, change, rejection) => {
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, ...change })?.rejection).toBe(rejection)
  })

  it("accepts a confidence exactly at the threshold", () => {
    expect(readVlmFaceMatchVerdict({ ...fullVerdict, matchConfidence: { value: 0.7 } })?.rejection).toBeNull()
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
      rejection: "VLM face match did not confirm the selfie against the ID photograph",
    }))
  })
})
