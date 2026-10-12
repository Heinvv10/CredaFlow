/**
 * The real ONNX models on synthetic images. No real face is used anywhere:
 * every "face" here is drawn or computed. Skipped unless FACE_MODEL_TESTS=1;
 * with it set, missing models FAIL (the load test), never skip. CI runs it
 * after `npm run face-models:fetch` (.github/workflows/quality-gate.yml):
 *
 *   FACE_MODEL_TESTS=1 npx vitest run lib/kyc/face-model/compare.models.test.ts
 */
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { alignedFaceTensor, SFACE_LANDMARK_TEMPLATE } from "./align"
import { compareFaces } from "./compare.server"
import { loadFaceModelRuntime } from "./runtime.server"
import { yunetInputTensor, type RgbImage } from "./yunet"

const suite = process.env.FACE_MODEL_TESTS === "1" ? describe : describe.skip

// The specimen card's photo box (scripts/demo/specimens/id-card.ts) on a plain card.
const BOX = { x: 80, y: 210, w: 440, h: 560 }
const cx = BOX.x + BOX.w / 2

const card = (photoBox: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1712" height="1080">
  <rect width="1712" height="1080" rx="48" fill="#eef1ea"/>
  <rect x="580" y="240" width="700" height="40" fill="#c9cfc6"/><rect x="580" y="360" width="500" height="40" fill="#c9cfc6"/>
  ${photoBox}</svg>`)).png().toBuffer()

const silhouette = `<rect x="${BOX.x}" y="${BOX.y}" width="${BOX.w}" height="${BOX.h}" rx="16" fill="#dfe3e1"/>
  <circle cx="${cx}" cy="420" r="105" fill="#a9b2ad"/><path d="M130 770 C130 600 470 600 470 770 Z" fill="#a9b2ad"/>`
const blank = `<rect x="${BOX.x}" y="${BOX.y}" width="${BOX.w}" height="${BOX.h}" rx="16" fill="#e0e3e1"/>`
const cartoonFace = `<rect x="${BOX.x}" y="${BOX.y}" width="${BOX.w}" height="${BOX.h}" rx="16" fill="#bcd7ea"/>
  <ellipse cx="${cx}" cy="470" rx="140" ry="175" fill="#f1c29a" stroke="#7a4a2a" stroke-width="5"/>
  <ellipse cx="${cx - 55}" cy="460" rx="22" ry="28" fill="#fff" stroke="#222" stroke-width="4"/>
  <ellipse cx="${cx + 55}" cy="460" rx="22" ry="28" fill="#fff" stroke="#222" stroke-width="4"/>
  <circle cx="${cx - 52}" cy="466" r="11" fill="#222"/><circle cx="${cx + 58}" cy="466" r="11" fill="#222"/>
  <path d="M ${cx} 480 L ${cx - 15} 530 L ${cx + 12} 532" stroke="#7a4a2a" stroke-width="4" fill="none"/>
  <path d="M ${cx - 60} 560 Q ${cx} 605 ${cx + 60} 560" stroke="#8a2a2a" stroke-width="7" fill="none"/>`
const obscured = `${cartoonFace}<rect x="${BOX.x}" y="${BOX.y + 150}" width="${BOX.w}" height="330" fill="#111"/>`

/** Grey-level noise: textured, but no face. */
async function noise(): Promise<Buffer> {
  const data = Buffer.alloc(640 * 480 * 3)
  let seed = 7
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    data[i] = seed & 0xff
  }
  return sharp(data, { raw: { width: 640, height: 480, channels: 3 } }).jpeg().toBuffer()
}

/** A fixed, formula-generated RGB image: the same bytes on every machine. */
function pattern(width: number, height: number): RgbImage {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = (x * 3 + y * 5 + c * 85 + ((x * y) >> 4)) & 255
    }
  }
  return { data, width, height }
}

/** Within 0.1% (or 0.001 absolute, for the near-zero sums): kernel noise, not a preprocessing change. */
const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-3 * Math.abs(expected), 1e-3))

suite("compareFaces with the real models", () => {
  it("loads both models after verifying their checksums", async () => {
    await expect(loadFaceModelRuntime()).resolves.toEqual(
      expect.objectContaining({ detect: expect.any(Function), embed: expect.any(Function) }),
    )
  })

  it("finds no face in noise, on either side", async () => {
    const image = { fileBuffer: await noise(), mimeType: "image/jpeg" }
    expect(await compareFaces(image, image)).toEqual({
      ok: false,
      rejection: expect.objectContaining({ reason: "extraction_incomplete" }),
      idFaceCount: 0,
      selfieFaceCount: 0,
    })
  })

  // A placeholder card can never pass, even compared against itself.
  it.each([
    ["silhouette", silhouette],
    ["blank", blank],
    ["cartoon", cartoonFace],
    ["obscured", obscured],
  ])("never passes a %s photo box", async (_label, box) => {
    const image = { fileBuffer: await card(box), mimeType: "image/png" }
    const result = await compareFaces(image, image)
    expect(result.ok && result.rejection === null).toBe(false)
  })

  // Golden values on fixed synthetic input, so a regression in preprocessing
  // (channel order, padding, alignment, interpolation) goes red without
  // needing a real face. Recorded 2026-10-12 on onnxruntime-node 1.30.0, CPU;
  // identical at 1 and 32 threads.
  it("produces the pinned YuNet outputs for a fixed synthetic image", async () => {
    const outputs = await (await loadFaceModelRuntime()).detect(yunetInputTensor(pattern(320, 240)))
    const golden: Record<string, number> = {
      bbox_8: 17876.0701, bbox_16: 1644.9988, bbox_32: 2385.6177,
      cls_8: 4839.4983, cls_16: 862.8916, cls_32: 280.0263,
      kps_8: 35036.9951, kps_16: 8144.6963, kps_32: 3443.0362,
      obj_8: 0.0003, obj_16: 0.0032, obj_32: 0.2672,
    }
    expect(Object.keys(outputs).sort()).toEqual(Object.keys(golden).sort())
    for (const [name, sum] of Object.entries(golden)) near(outputs[name].reduce((a, b) => a + b, 0), sum)
  })

  it("produces the pinned SFace embedding for a fixed synthetic aligned crop", async () => {
    const landmarks = SFACE_LANDMARK_TEMPLATE.flat().map((v, i) => v * 1.5 + (i % 2 === 0 ? 20 : 10))
    const embedding = await (await loadFaceModelRuntime()).embed(alignedFaceTensor(pattern(200, 200), landmarks))
    expect(embedding).toHaveLength(128)
    const norm = Math.hypot(...embedding)
    // Projections of the unit embedding onto fixed directions: every value counts.
    const projections = [0, 1, 2, 3].map((k) => embedding.reduce((a, v, i) => a + v * Math.sin(i * (k + 1)), 0) / norm)
    const golden = [-0.57479, 0.13583, -0.07412, -0.03459]
    projections.forEach((value, k) => expect(Math.abs(value - golden[k])).toBeLessThanOrEqual(2e-3))
  })

  it("is deterministic", async () => {
    const image = { fileBuffer: await noise(), mimeType: "image/jpeg" }
    expect(await compareFaces(image, image)).toEqual(await compareFaces(image, image))
  })
})
