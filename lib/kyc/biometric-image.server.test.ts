import { createHash, randomBytes } from "node:crypto"
import sharp from "sharp"
import { beforeEach, describe, expect, it, vi } from "vitest"

const documentImageMock = vi.fn()
vi.mock("@/lib/vlm-extract", () => ({
  documentImage: (...args: unknown[]) => documentImageMock(...args),
}))

import {
  CANONICAL_IMAGE_MAX_BYTES,
  CANONICAL_IMAGE_MAX_EDGE_PX,
  MAX_CONCURRENT_CANONICALISATIONS,
  canonicalBiometricImage,
} from "./biometric-image.server"
import { oversizedPng } from "./biometric-image.test-helpers"


const pixel = async (jpeg: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
  return [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)]
}

beforeEach(() => {
  vi.resetAllMocks()
  documentImageMock.mockImplementation(async (buffer: Buffer, mimeType: string) => ({ ok: true, buffer, mimeType }))
})

describe("canonicalBiometricImage", () => {
  it("re-encodes as JPEG and reports the SHA-256 of exactly those bytes", async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#336699" } }).png().toBuffer()
    const result = await canonicalBiometricImage(png, "image/png")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.image.mimeType).toBe("image/jpeg")
    expect((await sharp(result.image.fileBuffer).metadata()).format).toBe("jpeg")
    expect(result.image.sha256).toBe(createHash("sha256").update(result.image.fileBuffer).digest("hex"))
  })

  // The breaker's case: an RGBA PNG composites one way for a decoder that
  // flattens and another for a VLM that drops alpha. Both now get white.
  it("flattens transparency onto white", async () => {
    const rgba = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const result = await canonicalBiometricImage(rgba, "image/png")
    if (!result.ok) throw new Error("expected a canonical image")
    for (const channel of await pixel(result.image.fileBuffer, 10, 10)) expect(channel).toBeGreaterThan(250)
    expect((await sharp(result.image.fileBuffer).metadata()).channels).toBe(3)
  })

  it("applies EXIF orientation and drops the tag, so no reader rotates again", async () => {
    const tagged = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#ff0000" } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const result = await canonicalBiometricImage(tagged, "image/jpeg")
    if (!result.ok) throw new Error("expected a canonical image")
    const metadata = await sharp(result.image.fileBuffer).metadata()
    expect([metadata.width, metadata.height]).toEqual([20, 40])
    expect(metadata.orientation ?? 1).toBe(1)
  })

  it("renders a PDF once, through the page render the VLM used", async () => {
    const page = await sharp({ create: { width: 30, height: 40, channels: 3, background: "#ffffff" } }).jpeg().toBuffer()
    documentImageMock.mockResolvedValueOnce({ ok: true, buffer: page, mimeType: "image/jpeg" })
    const pdf = Buffer.from("%PDF-1.7 synthetic")
    const result = await canonicalBiometricImage(pdf, "application/pdf")
    expect(documentImageMock).toHaveBeenCalledOnce()
    expect(documentImageMock).toHaveBeenCalledWith(pdf, "application/pdf")
    expect(result.ok).toBe(true)
  })

  it("fails, never passing bytes through, when a PDF will not render", async () => {
    documentImageMock.mockResolvedValueOnce({ ok: false, error: "PDF conversion failed: synthetic" })
    expect(await canonicalBiometricImage(Buffer.from("%PDF"), "application/pdf")).toEqual({
      ok: false, error: "PDF conversion failed: synthetic",
    })
  })

  // The canonical bytes go to the shared VLM base64-encoded: unbounded, a
  // 1.5 MB 16000 px checkerboard PNG became a 66 MB JPEG.
  describe("bounds", () => {
    it("caps the long edge at 2048 px, keeping the aspect ratio, and never enlarges", async () => {
      const wide = await sharp({ create: { width: 5000, height: 2500, channels: 3, background: "#556677" } }).png().toBuffer()
      const result = await canonicalBiometricImage(wide, "image/png")
      if (!result.ok) throw new Error("expected a canonical image")
      const metadata = await sharp(result.image.fileBuffer).metadata()
      expect([metadata.width, metadata.height]).toEqual([CANONICAL_IMAGE_MAX_EDGE_PX, 1024])
      const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#556677" } }).png().toBuffer()
      const kept = await canonicalBiometricImage(small, "image/png")
      if (!kept.ok) throw new Error("expected a canonical image")
      const keptMetadata = await sharp(kept.image.fileBuffer).metadata()
      expect([keptMetadata.width, keptMetadata.height]).toEqual([300, 200])
    })

    it("keeps a large checkerboard bounded", async () => {
      const side = 6000
      const pixels = Buffer.alloc(side * side)
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) pixels[y * side + x] = (x + y) & 1 ? 255 : 0
      const checkerboard = await sharp(pixels, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer()
      const result = await canonicalBiometricImage(checkerboard, "image/png")
      if (!result.ok) throw new Error("expected a canonical image")
      const metadata = await sharp(result.image.fileBuffer).metadata()
      expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(CANONICAL_IMAGE_MAX_EDGE_PX)
      expect(result.image.fileBuffer.length).toBeLessThan(CANONICAL_IMAGE_MAX_BYTES)
    }, 30_000)

    it("refuses a canonical image above 8 MiB, as random noise at the cap is", async () => {
      const side = CANONICAL_IMAGE_MAX_EDGE_PX
      const noise = await sharp(randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } }).png().toBuffer()
      expect(await canonicalBiometricImage(noise, "image/png")).toEqual({
        ok: false, error: "The prepared image is larger than 8 MiB",
      })
    }, 30_000)
  })

  // Decoding happens before the 2048 px cap: an interlaced 16383 px PNG or a
  // progressive JPEG cost ~1 GB RSS each, and four at once ~3.5 GB.
  describe("decode limits", () => {
    it("refuses an image above 50 megapixels from its header, quickly", async () => {
      const started = Date.now()
      expect(await canonicalBiometricImage(oversizedPng(16383), "image/png")).toEqual({
        ok: false, error: "The image is larger than 50 megapixels",
      })
      expect(await canonicalBiometricImage(oversizedPng(7072), "image/png")).toEqual({
        ok: false, error: "The image is larger than 50 megapixels",
      })
      expect(Date.now() - started).toBeLessThan(1000)
    })

    it("accepts a 48 MP phone photo", async () => {
      const photo = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#7a6a5a" } }).jpeg().toBuffer()
      const result = await canonicalBiometricImage(photo, "image/jpeg")
      if (!result.ok) throw new Error(`expected a canonical image, got: ${result.error}`)
      const metadata = await sharp(result.image.fileBuffer).metadata()
      expect([metadata.width, metadata.height]).toEqual([2048, 1536])
    }, 30_000)

    it(`runs at most ${MAX_CONCURRENT_CANONICALISATIONS} at once; the next waits for a slot`, async () => {
      const page = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#ffffff" } }).jpeg().toBuffer()
      const releases: Array<() => void> = []
      documentImageMock.mockImplementation((buffer: Buffer) => new Promise((resolve) => {
        releases.push(() => resolve({ ok: true, buffer: page, mimeType: "image/jpeg" }))
      }))
      const calls = [1, 2, 3].map((n) => canonicalBiometricImage(Buffer.from(`pdf-${n}`), "application/pdf"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(documentImageMock).toHaveBeenCalledTimes(2)
      releases[0]()
      await vi.waitFor(() => expect(documentImageMock).toHaveBeenCalledTimes(3))
      releases[1]()
      releases[2]()
      expect((await Promise.all(calls)).every((result) => result.ok)).toBe(true)
    })
  })

  it("fails on bytes that are not an image", async () => {
    expect(await canonicalBiometricImage(Buffer.from("not an image"), "image/jpeg")).toEqual({
      ok: false, error: "The image could not be decoded",
    })
  })
})
