/**
 * The real ONNX models on synthetic images. No real face is used anywhere:
 * every "face" here is drawn. Skipped unless FACE_MODEL_TESTS=1 and the
 * models are fetched (npm run face-models:fetch):
 *
 *   FACE_MODEL_TESTS=1 npx vitest run lib/kyc/face-model/compare.models.test.ts
 */
import { existsSync } from "node:fs"
import path from "node:path"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { compareFaces } from "./compare.server"
import { FACE_MODELS } from "./models"
import { faceModelDir, loadFaceModelRuntime } from "./runtime.server"

const present = Object.values(FACE_MODELS).every((model) => existsSync(path.join(faceModelDir(), model.file)))
const suite = process.env.FACE_MODEL_TESTS === "1" && present ? describe : describe.skip

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
      rejection: expect.objectContaining({ reason: "id_document_portrait_invalid" }),
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

  it("is deterministic", async () => {
    const image = { fileBuffer: await noise(), mimeType: "image/jpeg" }
    expect(await compareFaces(image, image)).toEqual(await compareFaces(image, image))
  })
})
