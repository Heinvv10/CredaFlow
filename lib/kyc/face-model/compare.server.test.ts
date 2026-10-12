import sharp from "sharp"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { oversizedPng } from "@/lib/kyc/biometric-image.test-helpers"
import { faceModelEvidenceRefusal } from "./evidence"
import {
  FACE_MODELS,
  FACE_MODEL_DETECTOR_RUNTIME_SHA256,
  FACE_SIMILARITY_THRESHOLD,
  MIN_ALIGNED_CROP_SHARPNESS,
  MIN_INTER_OCULAR_PX,
  MIN_LANDMARK_GEOMETRY_MARGIN,
} from "./models"
import type { FaceModelRuntime } from "./runtime.server"
import { YUNET_INPUT_SIZE, type YunetOutputs } from "./yunet"

import { compareFaces, decodeImage, isSamePerson } from "./compare.server"

// Landmark offsets in cells, before scaling by the face size: eyes, nose,
// mouth corners in YuNet's order. Upright and well proportioned.
const UPRIGHT_KPS = [-0.3, -0.2, 0.3, -0.2, 0, 0, -0.25, 0.3, 0.25, 0.3]

/**
 * YuNet outputs holding one stride-32 face per entry, `size` cells wide, at
 * cell (row, col), for an input of width x height (640x640 by default).
 */
function outputsWithFaces(
  faces: Array<{ row: number; col: number; size: number; kps?: number[] }>,
  width = YUNET_INPUT_SIZE,
  height = YUNET_INPUT_SIZE,
): YunetOutputs {
  const outputs: YunetOutputs = {}
  for (const stride of [8, 16, 32]) {
    const cells = (width / stride) * (height / stride)
    outputs[`cls_${stride}`] = new Float32Array(cells)
    outputs[`obj_${stride}`] = new Float32Array(cells)
    outputs[`bbox_${stride}`] = new Float32Array(cells * 4)
    outputs[`kps_${stride}`] = new Float32Array(cells * 10)
  }
  for (const { row, col, size, kps = UPRIGHT_KPS } of faces) {
    const index = row * (width / 32) + col
    outputs.cls_32[index] = 1
    outputs.obj_32[index] = 1
    outputs.bbox_32.set([0, 0, Math.log(size), Math.log(size)], index * 4)
    outputs.kps_32.set(kps.map((v) => v * size), index * 10)
  }
  return outputs
}

const ONE_FACE = outputsWithFaces([{ row: 5, col: 5, size: 3 }])
const NO_FACE = outputsWithFaces([])

function fakeRuntime(id: YunetOutputs, selfie: YunetOutputs, embeddings: number[][]): FaceModelRuntime {
  return {
    detect: vi.fn().mockResolvedValueOnce(id).mockResolvedValueOnce(selfie),
    embed: vi.fn()
      .mockResolvedValueOnce(Float32Array.from(embeddings[0]))
      .mockResolvedValueOnce(Float32Array.from(embeddings[1])),
  }
}

let png: Buffer
let flatPng: Buffer
const image = () => ({ fileBuffer: png, mimeType: "image/png" })
const run = (runtime: FaceModelRuntime | Promise<FaceModelRuntime>, timeoutMs = 5000) =>
  compareFaces(image(), image(), { loadRuntime: () => Promise.resolve(runtime), timeoutMs })

beforeEach(async () => {
  vi.resetAllMocks()
  // Textured, so an aligned crop carries detail (a flat crop fails the sharpness floor).
  const data = Buffer.alloc(640 * 480 * 3)
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + ((i / 1920) | 0) * 11) & 255
  png = await sharp(data, { raw: { width: 640, height: 480, channels: 3 } }).png().toBuffer()
  flatPng = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#808080" } }).png().toBuffer()
})

describe("isSamePerson", () => {
  it("passes at and above the threshold and fails just below it", () => {
    expect(isSamePerson(FACE_SIMILARITY_THRESHOLD)).toBe(true)
    expect(isSamePerson(0.9)).toBe(true)
    expect(isSamePerson(0.36299999999999993)).toBe(false)
    expect(isSamePerson(Number.NaN)).toBe(false)
  })
})

describe("compareFaces", () => {
  it("records a same-person decision whose evidence re-proves itself", async () => {
    const result = await run(fakeRuntime(ONE_FACE, ONE_FACE, [[1, 0], [0.8, 0.6]]))
    expect(result).toEqual({
      ok: true,
      rejection: null,
      evidence: {
        detector: FACE_MODELS.detector.name,
        detectorSha256: FACE_MODELS.detector.sha256,
        detectorRuntimeSha256: FACE_MODEL_DETECTOR_RUNTIME_SHA256,
        recognizer: FACE_MODELS.recognizer.name,
        recognizerSha256: FACE_MODELS.recognizer.sha256,
        selfieFaceCount: 1,
        idFaceCount: 1,
        idSecondFaceAreaRatio: null,
        idDetectPass: "fit640",
        // 0.6 cells x 3 x 32 px; the margin is the nose depth, 0.2 / 0.6.
        idInterOcularPx: expect.closeTo(57.6, 3),
        selfieInterOcularPx: expect.closeTo(57.6, 3),
        idGeometryMargin: expect.closeTo(1 / 3, 6),
        selfieGeometryMargin: expect.closeTo(1 / 3, 6),
        idSharpness: expect.any(Number),
        selfieSharpness: expect.any(Number),
        similarity: expect.closeTo(0.8, 6),
        threshold: FACE_SIMILARITY_THRESHOLD,
        samePerson: true,
      },
    })
    expect(result.ok && faceModelEvidenceRefusal(result.evidence)).toBeNull()
  })

  it("refuses a similarity below the threshold, keeping the evidence", async () => {
    const result = await run(fakeRuntime(ONE_FACE, ONE_FACE, [[1, 0], [0.3, Math.sqrt(1 - 0.09)]]))
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      rejection: { reason: "match_score_below_threshold", message: "Face comparison similarity below threshold" },
      evidence: expect.objectContaining({ similarity: expect.closeTo(0.3, 6), samePerson: false }),
    }))
  })

  it("uses the dominant ID face beside a small ghost portrait", async () => {
    const id = outputsWithFaces([{ row: 5, col: 5, size: 4 }, { row: 15, col: 15, size: 1 }])
    const result = await run(fakeRuntime(id, ONE_FACE, [[1, 0], [1, 0]]))
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      rejection: null,
      evidence: expect.objectContaining({ idFaceCount: 2, idSecondFaceAreaRatio: expect.closeTo(1 / 16, 6), similarity: 1 }),
    }))
  })

  const refusal = (reason: string, message: string, idFaceCount: number | null, selfieFaceCount: number | null) =>
    ({ ok: false, rejection: { reason, message }, idFaceCount, selfieFaceCount })

  it.each([
    ["no face on the ID", NO_FACE, ONE_FACE,
      refusal("extraction_incomplete", "No face found in the ID document photograph by the face comparison", 0, 1)],
    ["two comparable faces on the ID", outputsWithFaces([{ row: 5, col: 5, size: 3 }, { row: 15, col: 15, size: 3 }]), ONE_FACE,
      refusal("extraction_incomplete", "The ID document shows 2 faces of comparable size; the face comparison cannot tell whose it is", 2, 1)],
    ["no face in the selfie", ONE_FACE, NO_FACE,
      refusal("face_not_detected", "No face found in the selfie by the face comparison", 1, 0)],
    ["two faces in the selfie", ONE_FACE, outputsWithFaces([{ row: 5, col: 5, size: 3 }, { row: 15, col: 15, size: 1 }]),
      refusal("face_count_invalid", "The selfie shows 2 faces; the face comparison needs exactly one", 1, 2)],
    ["no face on either side (the ID side's message is named)", NO_FACE, NO_FACE,
      refusal("extraction_incomplete", "No face found in the ID document photograph by the face comparison", 0, 0)],
  ])("refuses %s", async (_label, id, selfie, expected) => {
    const runtime = fakeRuntime(id, selfie, [[1, 0], [1, 0]])
    expect(await run(runtime)).toEqual(expected)
    expect(runtime.embed).not.toHaveBeenCalled()
  })

  // Model-side gates that do not depend on the VLM. SFace scores two
  // different drawn faces, or face-free crops, far above the threshold.
  describe("refuses a detected face that is not a usable real face", () => {
    const small = outputsWithFaces([{ row: 5, col: 5, size: 1 }]) // eyes 0.6 x 32 = 19.2 px apart
    const noseAbove = outputsWithFaces([{ row: 5, col: 5, size: 3, kps: [-0.3, 0, 0.3, 0, 0, -0.3, -0.25, 0.3, 0.25, 0.3] }])
    const collinear = outputsWithFaces([{ row: 5, col: 5, size: 3, kps: [-0.3, 0, 0.3, 0, 0, 0, -0.25, 0, 0.25, 0] }])
    const upsideDown = outputsWithFaces([{ row: 5, col: 5, size: 3, kps: UPRIGHT_KPS.map((v) => -v) }])

    it.each([
      ["the ID face's eyes closer than the floor", small, ONE_FACE, "The face on the ID document is too small for the face comparison"],
      ["the selfie face's eyes closer than the floor", ONE_FACE, small, "The face in the selfie is too small for the face comparison"],
      ["an ID face with the nose above the eyes", noseAbove, ONE_FACE, "The face on the ID document does not have the layout of a face"],
      ["an ID face with collinear landmarks", collinear, ONE_FACE, "The face on the ID document does not have the layout of a face"],
      ["an upside-down selfie face", ONE_FACE, upsideDown, "The face in the selfie does not have the layout of a face"],
    ])("refuses %s", async (_label, id, selfie, message) => {
      const runtime = fakeRuntime(id, selfie, [[1, 0], [1, 0]])
      expect(await run(runtime)).toEqual({
        ok: false, rejection: { reason: "extraction_incomplete", message }, idFaceCount: 1, selfieFaceCount: 1,
      })
      expect(runtime.embed).not.toHaveBeenCalled()
    })

    it.each([
      ["ID", () => ({ fileBuffer: flatPng, mimeType: "image/png" }), image, "The face on the ID document is too blurred for the face comparison"],
      ["selfie", image, () => ({ fileBuffer: flatPng, mimeType: "image/png" }), "The face in the selfie is too blurred for the face comparison"],
    ])("refuses a flat (blurred) %s crop", async (_side, id, selfie, message) => {
      const runtime = fakeRuntime(ONE_FACE, ONE_FACE, [[1, 0], [1, 0]])
      const result = await compareFaces(id(), selfie(), { loadRuntime: () => Promise.resolve(runtime), timeoutMs: 5000 })
      expect(result).toEqual({ ok: false, rejection: { reason: "extraction_incomplete", message }, idFaceCount: 1, selfieFaceCount: 1 })
    })

    it("records measures above every floor on a passing comparison", async () => {
      const result = await run(fakeRuntime(ONE_FACE, ONE_FACE, [[1, 0], [1, 0]]))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.evidence.idInterOcularPx).toBeGreaterThanOrEqual(MIN_INTER_OCULAR_PX)
      expect(result.evidence.idGeometryMargin).toBeGreaterThanOrEqual(MIN_LANDMARK_GEOMETRY_MARGIN)
      expect(result.evidence.idSharpness).toBeGreaterThanOrEqual(MIN_ALIGNED_CROP_SHARPNESS)
      expect(result.evidence.selfieSharpness).toBeGreaterThanOrEqual(MIN_ALIGNED_CROP_SHARPNESS)
    })
  })

  // A certified ID copy is often an A4 scan: shrunk to fit 640, its face is
  // too small to detect, so a large ID image also gets a full-resolution
  // pass. BOTH passes always run on it: the face-count rule must hold on
  // each, or a page whose 640 pass sees one of two comparable faces would
  // verify a selfie of either (the breaker's REPRO 8).
  describe("an ID image larger than 640: both passes", () => {
    let largePng: Buffer
    beforeEach(async () => {
      const data = Buffer.alloc(1280 * 960 * 3)
      for (let i = 0; i < data.length; i++) data[i] = (i * 37 + ((i / 3840) | 0) * 11) & 255
      largePng = await sharp(data, { raw: { width: 1280, height: 960, channels: 3 } }).png().toBuffer()
    })
    const large = () => ({ fileBuffer: largePng, mimeType: "image/png" })
    const full = (faces: Array<{ row: number; col: number; size: number }>) => outputsWithFaces(faces, 1280, 960)
    /** The ID's 640 pass, its full pass, then the selfie's (only) pass. */
    const runtimeFor = (fit: YunetOutputs, fullPass: YunetOutputs, selfie = ONE_FACE): FaceModelRuntime => ({
      detect: vi.fn().mockResolvedValueOnce(fit).mockResolvedValueOnce(fullPass).mockResolvedValueOnce(selfie),
      embed: vi.fn().mockResolvedValueOnce(Float32Array.from([1, 0])).mockResolvedValueOnce(Float32Array.from([1, 0])),
    })
    const runLarge = (runtime: FaceModelRuntime) =>
      compareFaces(large(), large(), { loadRuntime: () => Promise.resolve(runtime), timeoutMs: 5000 })
    const comparable = (count: number) => ({
      ok: false,
      rejection: {
        reason: "extraction_incomplete",
        message: `The ID document shows ${count} faces of comparable size; the face comparison cannot tell whose it is`,
      },
      idFaceCount: count,
      selfieFaceCount: 1,
    })

    it("runs the full pass too when the 640 pass finds the face, and compares the 640 pass's face", async () => {
      const runtime = runtimeFor(ONE_FACE, full([{ row: 10, col: 10, size: 3 }]))
      const result = await runLarge(runtime)
      expect(runtime.detect).toHaveBeenCalledTimes(3)
      expect(vi.mocked(runtime.detect).mock.calls[1].slice(1)).toEqual([960, 1280])
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        evidence: expect.objectContaining({ idDetectPass: "fit640", idFaceCount: 1, idSecondFaceAreaRatio: null }),
      }))
    })

    it("compares the full pass's face, in source pixels, when the 640 pass finds none", async () => {
      const result = await runLarge(runtimeFor(NO_FACE, full([{ row: 10, col: 10, size: 3 }])))
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        evidence: expect.objectContaining({ idDetectPass: "full", idFaceCount: 1, idInterOcularPx: expect.closeTo(57.6, 3) }),
      }))
    })

    it("keeps the 640 pass's face when the full pass finds none (a face too large for it)", async () => {
      const result = await runLarge(runtimeFor(ONE_FACE, full([])))
      expect(result).toEqual(expect.objectContaining({
        ok: true, evidence: expect.objectContaining({ idDetectPass: "fit640", idFaceCount: 1 }),
      }))
    })

    it("refuses when the full pass sees two comparable faces, though the 640 pass saw one", async () => {
      const runtime = runtimeFor(ONE_FACE, full([{ row: 10, col: 10, size: 3 }, { row: 20, col: 30, size: 3 }]))
      expect(await runLarge(runtime)).toEqual(comparable(2))
      expect(runtime.embed).not.toHaveBeenCalled()
    })

    it("refuses when the 640 pass sees two comparable faces, though the full pass saw one", async () => {
      const fit = outputsWithFaces([{ row: 5, col: 5, size: 3 }, { row: 12, col: 12, size: 3 }])
      expect(await runLarge(runtimeFor(fit, full([{ row: 10, col: 10, size: 3 }])))).toEqual(comparable(2))
    })

    it("refuses more than 64 faces on either pass", async () => {
      const many = Array.from({ length: 65 }, (_, i) => ({ row: 1 + (i % 25), col: 1 + Math.floor(i / 25) * 10, size: 1 }))
      const result = await runLarge(runtimeFor(ONE_FACE, full([{ row: 15, col: 20, size: 6 }, ...many])))
      expect(result).toEqual(expect.objectContaining({ ok: false, idFaceCount: 66, rejection: expect.objectContaining({ reason: "extraction_incomplete" }) }))
    })

    it("records the larger count, and that pass's ratio, beside the 640 pass's face", async () => {
      // The full pass also sees a small ghost portrait (1/9 of the area).
      const result = await runLarge(runtimeFor(ONE_FACE, full([{ row: 10, col: 10, size: 3 }, { row: 25, col: 35, size: 1 }])))
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        evidence: expect.objectContaining({
          idDetectPass: "fit640", idFaceCount: 2, idSecondFaceAreaRatio: expect.closeTo(1 / 9, 6),
        }),
      }))
    })

    it("refuses when neither pass finds a face", async () => {
      const runtime = runtimeFor(NO_FACE, full([]))
      expect(await runLarge(runtime)).toEqual(expect.objectContaining({
        ok: false, idFaceCount: 0,
        rejection: { reason: "extraction_incomplete", message: "No face found in the ID document photograph by the face comparison" },
      }))
      expect(runtime.detect).toHaveBeenCalledTimes(3)
    })

    it("runs only the 640 pass for an ID image that already fits 640", async () => {
      const runtime = fakeRuntime(NO_FACE, ONE_FACE, [[1, 0], [1, 0]])
      await run(runtime)
      expect(runtime.detect).toHaveBeenCalledTimes(2)
    })

    it("never runs a second pass on the selfie side", async () => {
      const runtime = runtimeFor(ONE_FACE, full([{ row: 10, col: 10, size: 3 }]), NO_FACE)
      expect(await runLarge(runtime)).toEqual(expect.objectContaining({
        ok: false, rejection: expect.objectContaining({ reason: "face_not_detected" }),
      }))
      expect(runtime.detect).toHaveBeenCalledTimes(3)
    })
  })

  const unavailable = (message: string, idFaceCount: number | null = null, selfieFaceCount: number | null = null) =>
    refusal("extraction_incomplete", message, idFaceCount, selfieFaceCount)

  it("fails closed when the models cannot be loaded", async () => {
    const result = await compareFaces(image(), image(), {
      loadRuntime: () => Promise.reject(new Error("checksum mismatch")),
      timeoutMs: 5000,
    })
    expect(result).toEqual(unavailable("Face comparison could not run: the face models are unavailable"))
  })

  it.each([
    // Factories: beforeEach's resetAllMocks would wipe mocks built at collection time.
    ["detection throws", () => ({ detect: vi.fn().mockRejectedValue(new Error("ort")), embed: vi.fn() }), null],
    ["the detector returns malformed outputs", () => ({ detect: vi.fn().mockResolvedValue({}), embed: vi.fn() }), null],
    ["embedding throws", () => ({ detect: vi.fn().mockResolvedValue(ONE_FACE), embed: vi.fn().mockRejectedValue(new Error("ort")) }), 1],
  ])("fails closed when %s", async (_label, runtime, count) => {
    expect(await run(runtime() as FaceModelRuntime)).toEqual(unavailable("Face comparison could not run", count, count))
  })

  it.each([
    ["a zero embedding", [[0, 0], [1, 0]]],
    ["a NaN embedding", [[Number.NaN, 1], [1, 0]]],
    ["embeddings of different lengths", [[1, 0, 0], [1, 0]]],
  ])("fails closed on %s instead of producing a similarity", async (_label, embeddings) => {
    expect(await run(fakeRuntime(ONE_FACE, ONE_FACE, embeddings))).toEqual(
      unavailable("Face comparison produced no valid similarity", 1, 1),
    )
  })

  it("fails closed when inference does not finish in time", async () => {
    const runtime = { detect: vi.fn(() => new Promise<YunetOutputs>(() => {})), embed: vi.fn() }
    expect(await run(runtime, 20)).toEqual(unavailable("Face comparison timed out"))
  })

  it("fails closed when loading the models does not finish in time", async () => {
    const result = await compareFaces(image(), image(), { loadRuntime: () => new Promise(() => {}), timeoutMs: 20 })
    expect(result).toEqual(unavailable("Face comparison timed out"))
  })

  it("refuses an ID image that cannot be decoded, without judging the portrait", async () => {
    const runtime = fakeRuntime(ONE_FACE, ONE_FACE, [[1, 0], [1, 0]])
    const result = await compareFaces({ fileBuffer: Buffer.from("not an image"), mimeType: "image/jpeg" }, image(), {
      loadRuntime: () => Promise.resolve(runtime), timeoutMs: 5000,
    })
    expect(result).toEqual(refusal("extraction_incomplete", "The ID document image could not be read for the face comparison", null, null))
    expect(runtime.detect).not.toHaveBeenCalled()
  })

  it("fails closed on a selfie that cannot be decoded", async () => {
    const result = await compareFaces(image(), { fileBuffer: Buffer.from("not an image"), mimeType: "image/png" }, {
      loadRuntime: () => Promise.resolve(fakeRuntime(ONE_FACE, ONE_FACE, [[1, 0], [1, 0]])), timeoutMs: 5000,
    })
    expect(result).toEqual(unavailable("The selfie image could not be read for the face comparison"))
  })

})

describe("decodeImage", () => {
  it("applies EXIF orientation", async () => {
    const rotated = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#ff0000" } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const decoded = await decodeImage(rotated)
    expect([decoded.width, decoded.height]).toEqual([20, 40])
    expect(decoded.data.length).toBe(20 * 40 * 3)
  })

  it("refuses to decode an image above 50 megapixels", async () => {
    await expect(decodeImage(oversizedPng(7072))).rejects.toThrow(/pixel limit/)
  })

  it("flattens transparency and shrinks a large image to at most 2048 on its long edge", async () => {
    const large = await sharp({ create: { width: 4096, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().toBuffer()
    const decoded = await decodeImage(large)
    expect([decoded.width, decoded.height]).toEqual([2048, 512])
    expect(decoded.data.length).toBe(2048 * 512 * 3)
    expect([...decoded.data.subarray(0, 3)]).toEqual([255, 255, 255])
  })
})
