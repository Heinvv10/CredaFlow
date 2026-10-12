import { describe, expect, it } from "vitest"
import { selectIdFace, selectSelfieFace } from "./face-count"
import type { DetectedFace } from "./yunet"

const face = (width: number, height: number, x = 0): DetectedFace => ({
  x, y: 0, width, height, score: 0.95, landmarks: new Array<number>(10).fill(0),
})

describe("selectSelfieFace", () => {
  it("uses the one face", () => {
    const only = face(100, 120)
    expect(selectSelfieFace([only])).toEqual({ ok: true, face: only, count: 1 })
  })

  it("refuses no face as face_not_detected", () => {
    expect(selectSelfieFace([])).toEqual({ ok: false, reason: "face_not_detected", count: 0 })
  })

  // A second, smaller face in a selfie is still a second person: no ghost rule here.
  it.each([
    ["two comparable faces", [face(100, 100), face(90, 90, 300)]],
    ["one large and one tiny face", [face(200, 200), face(20, 20, 400)]],
  ])("refuses %s as face_count_invalid", (_label, faces) => {
    expect(selectSelfieFace(faces)).toEqual({ ok: false, reason: "face_count_invalid", count: 2 })
  })
})

describe("selectIdFace", () => {
  it("uses the one face, with no second face to compare", () => {
    const only = face(100, 120)
    expect(selectIdFace([only])).toEqual({ ok: true, face: only, count: 1, secondFaceAreaRatio: null })
  })

  it("refuses no face", () => {
    expect(selectIdFace([])).toEqual({ ok: false, reason: "id_document_portrait_invalid", count: 0 })
  })

  // The smart ID card's small "ghost" portrait of the holder.
  it("uses the largest face when the other is a small ghost portrait, whatever the detection order", () => {
    const main = face(200, 250)
    const ghost = face(60, 75, 600)
    expect(selectIdFace([ghost, main])).toEqual({
      ok: true, face: main, count: 2, secondFaceAreaRatio: (60 * 75) / (200 * 250),
    })
  })

  it("accepts a second face at exactly half the largest's area and refuses one just over", () => {
    expect(selectIdFace([face(100, 100), face(50, 100, 300)])).toEqual(expect.objectContaining({
      ok: true, secondFaceAreaRatio: 0.5,
    }))
    expect(selectIdFace([face(100, 100), face(50.1, 100, 300)])).toEqual({
      ok: false, reason: "id_document_portrait_invalid", count: 2,
    })
  })

  it("refuses two comparable faces, and judges every other face, not just the second", () => {
    expect(selectIdFace([face(100, 100), face(95, 95, 300)])).toEqual({
      ok: false, reason: "id_document_portrait_invalid", count: 2,
    })
    expect(selectIdFace([face(100, 100), face(30, 30, 300), face(90, 90, 500)])).toEqual({
      ok: false, reason: "id_document_portrait_invalid", count: 3,
    })
  })

  it("reports the largest other face's ratio when several small faces are present", () => {
    const result = selectIdFace([face(100, 100), face(20, 20, 300), face(40, 40, 500)])
    expect(result).toEqual(expect.objectContaining({ ok: true, count: 3, secondFaceAreaRatio: 0.16 }))
  })
})
