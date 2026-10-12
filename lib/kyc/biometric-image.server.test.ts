import { createHash } from "node:crypto"
import sharp from "sharp"
import { beforeEach, describe, expect, it, vi } from "vitest"

const documentImageMock = vi.fn()
vi.mock("@/lib/vlm-extract", () => ({
  documentImage: (...args: unknown[]) => documentImageMock(...args),
}))

import { canonicalBiometricImage } from "./biometric-image.server"

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

  it("fails on bytes that are not an image", async () => {
    expect(await canonicalBiometricImage(Buffer.from("not an image"), "image/jpeg")).toEqual({
      ok: false, error: "The image could not be decoded",
    })
  })
})
