import { describe, expect, it } from "vitest"
import {
  YUNET_INPUT_SIZE,
  decodeYunetOutputs,
  nonMaxSuppression,
  yunetInputTensor,
  type DetectedFace,
  type YunetOutputs,
} from "./yunet"

const PLANE = YUNET_INPUT_SIZE * YUNET_INPUT_SIZE

/** All-zero model outputs for a 640x640 input: no cell scores above zero. */
function emptyOutputs(): YunetOutputs {
  const outputs: YunetOutputs = {}
  for (const stride of [8, 16, 32]) {
    const cells = (YUNET_INPUT_SIZE / stride) ** 2
    outputs[`cls_${stride}`] = new Float32Array(cells)
    outputs[`obj_${stride}`] = new Float32Array(cells)
    outputs[`bbox_${stride}`] = new Float32Array(cells * 4)
    outputs[`kps_${stride}`] = new Float32Array(cells * 10)
  }
  return outputs
}

/** Writes one cell's prediction at (row, col) of the given stride. */
function setCell(
  outputs: YunetOutputs,
  stride: number,
  row: number,
  col: number,
  cell: { cls: number; obj: number; bbox: number[]; kps: number[] },
) {
  const index = row * (YUNET_INPUT_SIZE / stride) + col
  outputs[`cls_${stride}`][index] = cell.cls
  outputs[`obj_${stride}`][index] = cell.obj
  outputs[`bbox_${stride}`].set(cell.bbox, index * 4)
  outputs[`kps_${stride}`].set(cell.kps, index * 10)
}

const face = (x: number, y: number, width: number, height: number, score: number): DetectedFace => ({
  x, y, width, height, score, landmarks: new Array<number>(10).fill(0),
})

describe("yunetInputTensor", () => {
  it("writes BGR planes of raw 0-255 values and zero-pads the bottom and right", () => {
    // Two pixels side by side: (R,G,B) = (10,20,30) and (40,50,60).
    const tensor = yunetInputTensor({ data: Uint8Array.from([10, 20, 30, 40, 50, 60]), width: 2, height: 1 })
    expect(tensor.length).toBe(3 * PLANE)
    expect([tensor[0], tensor[1]]).toEqual([30, 60]) // B plane
    expect([tensor[PLANE], tensor[PLANE + 1]]).toEqual([20, 50]) // G plane
    expect([tensor[2 * PLANE], tensor[2 * PLANE + 1]]).toEqual([10, 40]) // R plane
    expect(tensor[2]).toBe(0) // right of the image
    expect(tensor[YUNET_INPUT_SIZE]).toBe(0) // the row below it
    expect(tensor.reduce((sum, value) => sum + value, 0)).toBe(210)
  })

  it("keeps each row at its own offset in a multi-row image", () => {
    const tensor = yunetInputTensor({ data: Uint8Array.from([1, 2, 3, 4, 5, 6]), width: 1, height: 2 })
    expect([tensor[0], tensor[YUNET_INPUT_SIZE]]).toEqual([3, 6])
    expect([tensor[2 * PLANE], tensor[2 * PLANE + YUNET_INPUT_SIZE]]).toEqual([1, 4])
  })

  it.each([
    ["wider than the input", { width: 641, height: 1 }],
    ["taller than the input", { width: 1, height: 641 }],
    ["empty", { width: 0, height: 0 }],
  ])("refuses an image %s", (_label, size) => {
    expect(() => yunetInputTensor({ data: new Uint8Array(size.width * size.height * 3), ...size })).toThrow()
  })

  it("refuses pixel data that does not match the stated size", () => {
    expect(() => yunetInputTensor({ data: new Uint8Array(5), width: 2, height: 1 })).toThrow()
  })
})

describe("decodeYunetOutputs", () => {
  it("decodes a cell as OpenCV's FaceDetectorYN does: box, landmarks and sqrt(cls*obj)", () => {
    const outputs = emptyOutputs()
    setCell(outputs, 16, 3, 5, {
      cls: 0.81,
      obj: 1,
      bbox: [0.5, 0.25, Math.log(2), Math.log(4)],
      kps: [0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1],
    })
    const faces = decodeYunetOutputs(outputs, 1)
    expect(faces).toHaveLength(1)
    // cx = (5 + 0.5) * 16 = 88, cy = (3 + 0.25) * 16 = 52, w = 2 * 16, h = 4 * 16.
    expect(faces[0].x).toBeCloseTo(72, 4)
    expect(faces[0].y).toBeCloseTo(20, 4)
    expect(faces[0].width).toBeCloseTo(32, 4)
    expect(faces[0].height).toBeCloseTo(64, 4)
    expect(faces[0].score).toBeCloseTo(0.9, 5)
    // (kps + col) * stride, (kps + row) * stride.
    expect(faces[0].landmarks).toEqual([80, 48, 96, 48, 88, 56, 80, 64, 96, 64])
  })

  it("maps coordinates back to the original image by the resize scale", () => {
    const outputs = emptyOutputs()
    setCell(outputs, 8, 10, 20, { cls: 1, obj: 1, bbox: [0, 0, 0, 0], kps: new Array<number>(10).fill(0) })
    const [found] = decodeYunetOutputs(outputs, 0.5)
    // In the 640 frame: centre (160, 80), 8x8. At scale 0.5 the original is twice that.
    expect([found.x, found.y, found.width, found.height]).toEqual([312, 152, 16, 16])
    expect(found.landmarks.slice(0, 2)).toEqual([320, 160])
  })

  it("keeps a score at the threshold and drops one just below it", () => {
    const outputs = emptyOutputs()
    const cell = { bbox: [0, 0, 0, 0], kps: new Array<number>(10).fill(0) }
    setCell(outputs, 32, 1, 1, { ...cell, cls: 0.81, obj: 1 }) // 0.9
    setCell(outputs, 32, 10, 10, { ...cell, cls: 0.8, obj: 1 }) // 0.894
    expect(decodeYunetOutputs(outputs, 1).map((found) => found.y)).toEqual([32 - 16])
  })

  it("clamps cls and obj into 0..1 before combining them", () => {
    const outputs = emptyOutputs()
    const cell = { bbox: [0, 0, 0, 0], kps: new Array<number>(10).fill(0) }
    setCell(outputs, 32, 2, 2, { ...cell, cls: 4, obj: 0.81 }) // 4 * 0.81 would pass unclamped at 1.8
    setCell(outputs, 32, 5, 5, { ...cell, cls: 9, obj: -1 }) // negative objectness is zero, not NaN
    const faces = decodeYunetOutputs(outputs, 1)
    expect(faces).toHaveLength(1)
    expect(faces[0].score).toBeCloseTo(0.9, 5)
  })

  it("suppresses the weaker of two overlapping cells", () => {
    const outputs = emptyOutputs()
    const kps = new Array<number>(10).fill(0)
    // Two neighbouring stride-32 cells, each predicting the same 128x128 box.
    setCell(outputs, 32, 4, 4, { cls: 1, obj: 0.9, bbox: [0.5, 0, Math.log(4), Math.log(4)], kps })
    setCell(outputs, 32, 4, 5, { cls: 1, obj: 1, bbox: [-0.5, 0, Math.log(4), Math.log(4)], kps })
    const faces = decodeYunetOutputs(outputs, 1)
    expect(faces).toHaveLength(1)
    expect(faces[0].score).toBe(1)
  })

  it.each(["cls_8", "obj_16", "bbox_32", "kps_8"])("refuses outputs missing %s", (name) => {
    const outputs = emptyOutputs()
    delete outputs[name]
    expect(() => decodeYunetOutputs(outputs, 1)).toThrow()
  })

  it("refuses an output of the wrong length", () => {
    const outputs = emptyOutputs()
    outputs.bbox_16 = new Float32Array(10)
    expect(() => decodeYunetOutputs(outputs, 1)).toThrow()
  })

  it("refuses a non-finite prediction instead of emitting a NaN box", () => {
    const outputs = emptyOutputs()
    setCell(outputs, 32, 1, 1, { cls: 1, obj: 1, bbox: [Number.NaN, 0, 0, 0], kps: new Array<number>(10).fill(0) })
    expect(() => decodeYunetOutputs(outputs, 1)).toThrow()
  })
})

describe("nonMaxSuppression", () => {
  it("keeps the highest score first and drops boxes overlapping a kept one", () => {
    const kept = nonMaxSuppression([
      face(0, 0, 100, 100, 0.91),
      face(10, 10, 100, 100, 0.99), // IoU with the first is 0.68
      face(300, 300, 50, 50, 0.95),
    ])
    expect(kept.map((found) => found.score)).toEqual([0.99, 0.95])
  })

  it("keeps a box whose overlap is exactly the threshold and drops one just above", () => {
    // 100x100 boxes offset in x: intersection (100 - dx) * 100, union (100 + dx) * 100.
    // dx = 50 gives IoU 1/3; dx = 54 gives 46/154 = 0.2987.
    expect(nonMaxSuppression([face(0, 0, 100, 100, 0.99), face(50, 0, 100, 100, 0.95)], 1 / 3)).toHaveLength(2)
    expect(nonMaxSuppression([face(0, 0, 100, 100, 0.99), face(50, 0, 100, 100, 0.95)])).toHaveLength(1)
    expect(nonMaxSuppression([face(0, 0, 100, 100, 0.99), face(54, 0, 100, 100, 0.95)])).toHaveLength(2)
  })

  it("considers only the top-k scores", () => {
    const faces = [face(0, 0, 10, 10, 0.99), face(100, 0, 10, 10, 0.98), face(200, 0, 10, 10, 0.97)]
    expect(nonMaxSuppression(faces, 0.3, 2).map((found) => found.x)).toEqual([0, 100])
  })
})
