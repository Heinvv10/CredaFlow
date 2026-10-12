import { describe, expect, it } from "vitest"
import {
  SFACE_INPUT_SIZE,
  SFACE_LANDMARK_TEMPLATE,
  alignedFaceTensor,
  cosineSimilarity,
  similarityTransform,
} from "./align"

const TEMPLATE = SFACE_LANDMARK_TEMPLATE.flat()
const PLANE = SFACE_INPUT_SIZE * SFACE_INPUT_SIZE

/** Applies a 2x3 affine [a, b, tx, c, d, ty] to interleaved x,y points. */
function apply(matrix: number[], points: number[]): number[] {
  const [a, b, tx, c, d, ty] = matrix
  const out: number[] = []
  for (let i = 0; i < points.length; i += 2) {
    out.push(a * points[i] + b * points[i + 1] + tx, c * points[i] + d * points[i + 1] + ty)
  }
  return out
}

function expectClose(actual: number[], expected: number[], tolerance: number) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThan(tolerance))
}

describe("similarityTransform", () => {
  it("is the identity for landmarks already on the SFace template", () => {
    expectClose(similarityTransform(TEMPLATE), [1, 0, 0, 0, 1, 0], 1e-3)
  })

  it("undoes a scale, rotation and translation of the template", () => {
    // A face three times the template size, rotated 90 degrees, moved to (400, 250).
    const placed = apply([0, -3, 400, 3, 0, 250], TEMPLATE)
    const transform = similarityTransform(placed)
    expectClose(apply(transform, placed), TEMPLATE, 1e-3)
    // A similarity: rotation scaled by 1/3, no shear and no reflection.
    expectClose(transform.slice(0, 2).concat(transform.slice(3, 5)), [0, 1 / 3, -1 / 3, 0], 1e-4)
  })

  it("never reflects: mirrored landmarks get the best rotation, not a flip", () => {
    const mirrored = TEMPLATE.map((value, index) => (index % 2 === 0 ? 112 - value : value))
    const [a, b, , c, d] = similarityTransform(mirrored)
    expect(a * d - b * c).toBeGreaterThan(0)
  })

  it.each([
    ["all five landmarks on one point", new Array<number>(10).fill(50)],
    ["a non-finite landmark", TEMPLATE.map((value, index) => (index === 3 ? Number.NaN : value))],
    ["too few landmarks", TEMPLATE.slice(0, 8)],
  ])("refuses %s", (_label, landmarks) => {
    expect(() => similarityTransform(landmarks)).toThrow()
  })
})

describe("alignedFaceTensor", () => {
  // Each pixel encodes its own position: R = x, G = y, B = 7.
  const width = 200
  const height = 180
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([x, y, 7], (y * width + x) * 3)
  }
  const image = { data, width, height }

  it("crops 112x112 around a translated face, as RGB planes of raw 0-255 values", () => {
    const tensor = alignedFaceTensor(image, TEMPLATE.map((value, index) => value + (index % 2 === 0 ? 30 : 20)))
    expect(tensor.length).toBe(3 * PLANE)
    for (const [x, y] of [[0, 0], [5, 9], [111, 111]]) {
      const at = y * SFACE_INPUT_SIZE + x
      expect(tensor[at]).toBeCloseTo(x + 30, 1) // R plane
      expect(tensor[PLANE + at]).toBeCloseTo(y + 20, 1) // G plane
      expect(tensor[2 * PLANE + at]).toBeCloseTo(7, 1) // B plane
    }
  })

  it("interpolates between source pixels when the face is larger than the template", () => {
    // Template scaled 1.5x: output pixel (x, y) samples the source at (1.5x, 1.5y).
    const tensor = alignedFaceTensor(image, TEMPLATE.map((value) => value * 1.5))
    expect(tensor[1]).toBeCloseTo(1.5, 1)
    expect(tensor[PLANE + SFACE_INPUT_SIZE]).toBeCloseTo(1.5, 1)
    expect(tensor[2 * SFACE_INPUT_SIZE + 4]).toBeCloseTo(6, 1)
  })

  it("fills what falls outside the image with zeros", () => {
    const tensor = alignedFaceTensor(image, TEMPLATE.map((value, index) => value - (index % 2 === 0 ? 50 : 0)))
    expect([tensor[0], tensor[PLANE], tensor[2 * PLANE]]).toEqual([0, 0, 0]) // source x = -50
    expect(tensor[60]).toBeCloseTo(10, 1)
    expect(tensor[2 * PLANE + 60]).toBeCloseTo(7, 1)
  })
})

describe("cosineSimilarity", () => {
  const a = Float32Array.from([1, 2, 3, 4])

  it("is 1 for the same direction whatever the magnitude, -1 for the opposite, 0 for orthogonal", () => {
    expect(cosineSimilarity(a, a)).toBe(1)
    expect(cosineSimilarity(a, a.map((value) => value * 7.5))).toBeCloseTo(1, 6)
    expect(cosineSimilarity(a, a.map((value) => -value))).toBe(-1)
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0)
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 1]))).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it.each([
    ["a zero vector", new Float32Array(4)],
    ["a different length", Float32Array.from([1, 2, 3])],
    ["a NaN component", Float32Array.from([1, Number.NaN, 3, 4])],
    ["an infinite component", Float32Array.from([1, Number.POSITIVE_INFINITY, 3, 4])],
    ["an empty vector", new Float32Array(0)],
  ])("is NaN, never a number, against %s", (_label, b) => {
    expect(cosineSimilarity(a, b)).toBeNaN()
    expect(cosineSimilarity(b, a)).toBeNaN()
  })
})
