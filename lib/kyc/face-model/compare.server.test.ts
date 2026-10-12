import sharp from "sharp"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { faceModelEvidenceRefusal } from "./evidence"
import { FACE_MODELS, FACE_SIMILARITY_THRESHOLD } from "./models"
import type { FaceModelRuntime } from "./runtime.server"
import { YUNET_INPUT_SIZE, type YunetOutputs } from "./yunet"

const documentImageMock = vi.fn()
vi.mock("@/lib/vlm-extract", () => ({
  documentImage: (...args: unknown[]) => documentImageMock(...args),
}))

import { compareFaces, decodeImage, isSamePerson } from "./compare.server"

/** YuNet outputs holding one stride-32 face per entry, `size` cells wide, at cell (row, col). */
function outputsWithFaces(faces: Array<{ row: number; col: number; size: number }>): YunetOutputs {
  const outputs: YunetOutputs = {}
  for (const stride of [8, 16, 32]) {
    const cells = (YUNET_INPUT_SIZE / stride) ** 2
    outputs[`cls_${stride}`] = new Float32Array(cells)
    outputs[`obj_${stride}`] = new Float32Array(cells)
    outputs[`bbox_${stride}`] = new Float32Array(cells * 4)
    outputs[`kps_${stride}`] = new Float32Array(cells * 10)
  }
  for (const { row, col, size } of faces) {
    const index = row * (YUNET_INPUT_SIZE / 32) + col
    outputs.cls_32[index] = 1
    outputs.obj_32[index] = 1
    outputs.bbox_32.set([0, 0, Math.log(size), Math.log(size)], index * 4)
    outputs.kps_32.set([-0.3, -0.2, 0.3, -0.2, 0, 0, -0.25, 0.3, 0.25, 0.3].map((v) => v * size), index * 10)
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
const image = () => ({ fileBuffer: png, mimeType: "image/png" })
const run = (runtime: FaceModelRuntime | Promise<FaceModelRuntime>, timeoutMs = 5000) =>
  compareFaces(image(), image(), { loadRuntime: () => Promise.resolve(runtime), timeoutMs })

beforeEach(async () => {
  vi.resetAllMocks()
  png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#808080" } }).png().toBuffer()
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
        recognizer: FACE_MODELS.recognizer.name,
        recognizerSha256: FACE_MODELS.recognizer.sha256,
        selfieFaceCount: 1,
        idFaceCount: 1,
        idSecondFaceAreaRatio: null,
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

  it("reads a PDF ID through the same page render the VLM uses", async () => {
    documentImageMock.mockResolvedValue({ ok: true, buffer: png, mimeType: "image/jpeg" })
    const pdf = Buffer.from("%PDF-1.7 synthetic")
    const result = await compareFaces({ fileBuffer: pdf, mimeType: "application/pdf" }, image(), {
      loadRuntime: () => Promise.resolve(fakeRuntime(ONE_FACE, ONE_FACE, [[1, 0], [1, 0]])), timeoutMs: 5000,
    })
    expect(documentImageMock).toHaveBeenCalledWith(pdf, "application/pdf")
    expect(result.ok).toBe(true)
  })

  it("refuses a PDF ID whose page cannot be rendered", async () => {
    documentImageMock.mockResolvedValue({ ok: false, error: "PDF conversion failed" })
    const result = await compareFaces({ fileBuffer: Buffer.from("%PDF"), mimeType: "application/pdf" }, image(), {
      loadRuntime: () => Promise.resolve(fakeRuntime(ONE_FACE, ONE_FACE, [[1, 0], [1, 0]])), timeoutMs: 5000,
    })
    expect(result).toEqual(refusal("extraction_incomplete", "The ID document image could not be read for the face comparison", null, null))
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

  it("flattens transparency and shrinks a large image to at most 2048 on its long edge", async () => {
    const large = await sharp({ create: { width: 4096, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().toBuffer()
    const decoded = await decodeImage(large)
    expect([decoded.width, decoded.height]).toEqual([2048, 512])
    expect(decoded.data.length).toBe(2048 * 512 * 3)
    expect([...decoded.data.subarray(0, 3)]).toEqual([255, 255, 255])
  })
})
