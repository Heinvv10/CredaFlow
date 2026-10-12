import { describe, expect, it } from "vitest"
import { SFACE_INPUT_SIZE, SFACE_LANDMARK_TEMPLATE } from "./align"
import { alignedCropSharpness, interOcularDistance, landmarkGeometryMargin } from "./quality"

const TEMPLATE = SFACE_LANDMARK_TEMPLATE.flat()
const PLANE = SFACE_INPUT_SIZE * SFACE_INPUT_SIZE

/** Rotates interleaved x,y points by `degrees` about (cx, cy) and scales them. */
function transform(points: number[], degrees: number, scale = 1, cx = 56, cy = 72): number[] {
  const t = (degrees * Math.PI) / 180
  const out: number[] = []
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i] - cx
    const y = points[i + 1] - cy
    out.push(cx + scale * (x * Math.cos(t) - y * Math.sin(t)), cy + scale * (x * Math.sin(t) + y * Math.cos(t)))
  }
  return out
}

describe("interOcularDistance", () => {
  it("is the distance between the two eye landmarks, whatever the rest", () => {
    expect(interOcularDistance(TEMPLATE)).toBeCloseTo(Math.hypot(73.5318 - 38.2946, 51.5014 - 51.6963), 6)
    expect(interOcularDistance(transform(TEMPLATE, 30, 3))).toBeCloseTo(3 * interOcularDistance(TEMPLATE), 6)
  })
})

describe("landmarkGeometryMargin", () => {
  // On the template: the nose is ~0.57 eye-distances below the eyes, the
  // mouth ~0.58 below the nose, the mouth corners ~0.83 apart in eye order.
  it("is clearly positive for an upright face, and for one tilted 30 degrees either way", () => {
    expect(landmarkGeometryMargin(TEMPLATE)).toBeGreaterThan(0.5)
    expect(landmarkGeometryMargin(transform(TEMPLATE, 30))).toBeGreaterThan(0.5)
    expect(landmarkGeometryMargin(transform(TEMPLATE, -30))).toBeGreaterThan(0.5)
  })

  it("does not depend on the face's size", () => {
    expect(landmarkGeometryMargin(transform(TEMPLATE, 0, 7))).toBeCloseTo(landmarkGeometryMargin(TEMPLATE), 6)
  })

  const [rex, rey, lex, ley, nx, ny, rmx, rmy, lmx, lmy] = TEMPLATE
  it.each([
    ["five collinear landmarks", [10, 10, 20, 10, 30, 10, 40, 10, 50, 10]],
    ["collinear landmarks on a slant", [0, 0, 10, 10, 20, 20, 30, 30, 40, 40]],
    ["the nose above the eyes", [rex, rey, lex, ley, nx, rey - 15, rmx, rmy, lmx, lmy]],
    ["the mouth above the nose", [rex, rey, lex, ley, nx, ny, rmx, ny - 5, lmx, ny - 5]],
    ["the mouth corners swapped", [rex, rey, lex, ley, nx, ny, lmx, lmy, rmx, rmy]],
    ["the eyes swapped (a mirrored or upside-down face)", [lex, ley, rex, rey, nx, ny, rmx, rmy, lmx, lmy]],
    ["a face upside down", transform(TEMPLATE, 180)],
    ["a face turned 100 degrees", transform(TEMPLATE, 100)],
    ["both eyes on one point", [rex, rey, rex, rey, nx, ny, rmx, rmy, lmx, lmy]],
    ["a non-finite landmark", [rex, rey, lex, ley, Number.NaN, ny, rmx, rmy, lmx, lmy]],
  ])("is not positive for %s", (_label, landmarks) => {
    expect(landmarkGeometryMargin(landmarks)).not.toBeGreaterThan(0)
  })

  it("refuses the wrong number of landmarks", () => {
    expect(landmarkGeometryMargin(TEMPLATE.slice(0, 8))).not.toBeGreaterThan(0)
  })
})

describe("alignedCropSharpness", () => {
  const crop = (pixel: (x: number, y: number, c: number) => number) => {
    const tensor = new Float32Array(3 * PLANE)
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < SFACE_INPUT_SIZE; y++) {
        for (let x = 0; x < SFACE_INPUT_SIZE; x++) tensor[c * PLANE + y * SFACE_INPUT_SIZE + x] = pixel(x, y, c)
      }
    }
    return tensor
  }

  it("is zero for a flat crop of any colour, and for a linear gradient", () => {
    expect(alignedCropSharpness(crop(() => 0))).toBe(0)
    expect(alignedCropSharpness(crop((_x, _y, c) => [200, 170, 140][c]))).toBe(0)
    expect(alignedCropSharpness(crop((x) => x * 2))).toBeCloseTo(0, 6)
  })

  it("is the variance of the 4-neighbour Laplacian of the luma, inside an 8 px border", () => {
    // A checkerboard of 0/255 in every channel: luma 0/255, Laplacian ±1020.
    expect(alignedCropSharpness(crop((x, y) => ((x + y) % 2 === 0 ? 255 : 0)))).toBeCloseTo(1020 ** 2, 0)
  })

  it("ignores the border, where the warp fills zeros outside the image", () => {
    // The outer 7 px: the Laplacian of the first measured pixel (x = 8) reads x = 7.
    const edged = crop((x, y) => (x < 7 || y < 7 || x >= 105 || y >= 105 ? (x + y) % 2 === 0 ? 255 : 0 : 128))
    expect(alignedCropSharpness(edged)).toBe(0)
  })

  it("is higher for a sharp edge than for the same edge blurred", () => {
    const sharp = crop((x) => (x < 56 ? 40 : 220))
    const blurred = crop((x) => 40 + 180 / (1 + Math.exp(-(x - 56) / 6)))
    expect(alignedCropSharpness(sharp)).toBeGreaterThan(10 * alignedCropSharpness(blurred))
  })
})
