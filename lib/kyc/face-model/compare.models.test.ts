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
import { FACE_MODELS, FACE_MODEL_DETECTOR_RUNTIME_SHA256 } from "./models"
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

/**
 * Within 0.1% of the pinned value, relatively for every output: CPU-kernel
 * noise, not a preprocessing change. (An absolute floor let the near-zero
 * objectness sums pass whatever they were.)
 */
const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-3 * Math.abs(expected))

/**
 * A drawn face YuNet detects (parameters found by a seeded hill-climb), as the
 * ID-side A4 case: on a 1448x2048 page (an A4 scan at the 2048 px cap) at
 * 240 px wide, the 640-fit pass misses it and the full-resolution pass finds it.
 */
const DRAWN = [0.1059, 0.2947, 0.2704, 0.3327, 0, 0.3454, 0, 0.0765, 0.4639, 0.4661, 0.2854, 0.1019, 0.5198, 1, 0.619,
  0.5491, 0.4834, 0.5203, 1, 0, 0.7514, 0]
function drawnFace(p: number[]): Buffer {
  const v = (i: number, lo: number, hi: number) => lo + Math.min(1, Math.max(0, p[i])) * (hi - lo)
  const col = (i: number) => `rgb(${Math.round(v(i, 60, 250))},${Math.round(v(i + 1, 40, 220))},${Math.round(v(i + 2, 30, 200))})`
  const [cx, cy, rx, ry] = [300, 330, v(0, 120, 200), v(1, 150, 240)]
  const [ey, ex, er] = [cy - v(2, 10, 80), v(3, 40, 90), v(4, 10, 32)]
  const [ny, my, mw] = [cy + v(5, 10, 70), cy + v(6, 80, 150), v(7, 30, 90)]
  const eye = (x: number) => `<ellipse cx="${x}" cy="${ey}" rx="${er * 1.4}" ry="${er}" fill="#fff"/><circle cx="${x}" cy="${ey}" r="${er * v(18, 0.3, 0.8)}" fill="#222"/>`
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700">
  <rect width="600" height="700" fill="${col(8)}"/>
  <path d="M ${cx - rx - 20} ${cy - 20} Q ${cx} ${cy - ry - v(11, 20, 90)} ${cx + rx + 20} ${cy - 20} Z" fill="${col(12)}"/>
  <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${col(15)}"/>${eye(cx - ex)}${eye(cx + ex)}
  <path d="M ${cx - ex - 25} ${ey - er - v(19, 5, 25)} l 50 -${v(20, 0, 12)} M ${cx + ex - 25} ${ey - er - v(19, 5, 25) - v(20, 0, 12)} l 50 ${v(20, 0, 12)}" stroke="#332" stroke-width="7"/>
  <path d="M ${cx} ${ey + 10} L ${cx - v(21, 8, 25)} ${ny} L ${cx + 10} ${ny + 4}" stroke="#7a4a2a" stroke-width="5" fill="none"/>
  <path d="M ${cx - mw} ${my} Q ${cx} ${my + v(9, 0, 40)} ${cx + mw} ${my}" stroke="#8a2a2a" stroke-width="${v(10, 4, 14)}" fill="none"/>
  <path d="M ${cx - 230} 700 C ${cx - 200} ${cy + ry} ${cx + 200} ${cy + ry} ${cx + 230} 700 Z" fill="${col(12)}"/>
</svg>`)
}

suite("compareFaces with the real models", () => {
  it("rewrites the pinned detector into exactly the pinned runtime bytes", async () => {
    const { readVerifiedModel, faceModelDir: dir } = await import("./runtime.server")
    const { withSymbolicDetectorShape } = await import("./onnx-shape")
    const { createHash } = await import("node:crypto")
    const patched = withSymbolicDetectorShape(await readVerifiedModel(dir(), FACE_MODELS.detector))
    expect(createHash("sha256").update(patched).digest("hex")).toBe(FACE_MODEL_DETECTOR_RUNTIME_SHA256)
  })

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
    // Six significant figures each.
    const golden: Record<string, number> = {
      bbox_8: 17876.1, bbox_16: 1645.00, bbox_32: 2385.62,
      cls_8: 4839.50, cls_16: 862.892, cls_32: 280.026,
      kps_8: 35037.0, kps_16: 8144.70, kps_32: 3443.04,
      obj_8: 0.000324070, obj_16: 0.00321588, obj_32: 0.267197,
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

  it("finds a small ID face on an A4-like page only on the full-resolution pass", async () => {
    const face = await sharp(drawnFace(DRAWN)).png().toBuffer()
    const page = await sharp({ create: { width: 1448, height: 2048, channels: 3, background: "#ffffff" } })
      .composite([{ input: await sharp(face).resize(240).png().toBuffer(), left: 140, top: 160 }]).png().toBuffer()
    const result = await compareFaces({ fileBuffer: page, mimeType: "image/png" }, { fileBuffer: face, mimeType: "image/png" })
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      evidence: expect.objectContaining({ idDetectPass: "full", idFaceCount: 1, selfieFaceCount: 1 }),
    }))
  })

  // Why the fallback is a full-resolution pass and not trim-then-640: on a
  // certified copy with text near the page edges, trimming the page removes
  // almost nothing, and the face stays too small at 640.
  it("finds the ID face on a certified-copy page with header and footer text, on the full pass", async () => {
    const face = await sharp(drawnFace(DRAWN)).png().toBuffer()
    const line = (y: number) => `<rect x="40" y="${y}" width="1368" height="10" fill="#333"/>`
    const furniture = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1448" height="2048">
      ${line(20)}${line(2010)}
      <rect x="140" y="560" width="590" height="372" fill="#d8e0dc" stroke="#666" stroke-width="3"/>
      <circle cx="1030" cy="1300" r="150" fill="none" stroke="#1a3399" stroke-width="8"/>
      <rect x="760" y="1520" width="560" height="6" fill="#222"/></svg>`)
    const page = await sharp({ create: { width: 1448, height: 2048, channels: 3, background: "#f7f7f5" } })
      .composite([{ input: furniture }, { input: await sharp(face).resize(240).png().toBuffer(), left: 140, top: 160 }])
      .png().toBuffer()
    const trimmed = await sharp(page).trim({ threshold: 30 }).toBuffer({ resolveWithObject: true })
    expect(trimmed.info.width * trimmed.info.height).toBeGreaterThan(0.85 * 1448 * 2048)
    const result = await compareFaces({ fileBuffer: page, mimeType: "image/png" }, { fileBuffer: face, mimeType: "image/png" })
    expect(result).toEqual(expect.objectContaining({
      ok: true, evidence: expect.objectContaining({ idDetectPass: "full", idFaceCount: 1 }),
    }))
  })

  it("is deterministic", async () => {
    const image = { fileBuffer: await noise(), mimeType: "image/jpeg" }
    expect(await compareFaces(image, image)).toEqual(await compareFaces(image, image))
  })
})
