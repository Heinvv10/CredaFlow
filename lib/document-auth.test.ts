import { describe, it, expect, vi } from "vitest"

// document-auth.ts pulls in auth/prisma/tenant at module load; stub them so the
// pure magic-byte helper can be imported in isolation.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: vi.fn() }))

import { matchesMagic, MAGIC_BYTE_PREFIX } from "./document-auth"

// Pad an arbitrary byte prefix out to the number of bytes callers actually read.
function head(bytes: number[]): Uint8Array {
  const arr = new Uint8Array(MAGIC_BYTE_PREFIX)
  arr.set(bytes.slice(0, MAGIC_BYTE_PREFIX))
  return arr
}

describe("matchesMagic", () => {
  it("accepts a real PDF header (%PDF)", () => {
    expect(matchesMagic(head([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), "application/pdf")).toBe(true)
  })

  it("accepts a real PNG header", () => {
    expect(matchesMagic(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toBe(true)
  })

  it("accepts a real JPEG header", () => {
    expect(matchesMagic(head([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe(true)
  })

  it("accepts a real WebP header (RIFF....WEBP)", () => {
    expect(
      matchesMagic(head([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]), "image/webp"),
    ).toBe(true)
  })

  it("rejects a RIFF container that is not WebP (e.g. WAV) — offset-8 guard", () => {
    // First segment (RIFF) matches; "WAVE" at offset 8 does not.
    expect(
      matchesMagic(head([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]), "image/webp"),
    ).toBe(false)
  })

  it("rejects a text blob declared as PNG (spoofed Content-Type)", () => {
    expect(matchesMagic(head([0x68, 0x65, 0x6c, 0x6c, 0x6f]), "image/png")).toBe(false)
  })

  it("rejects an unknown / unsupported MIME (fails closed)", () => {
    expect(matchesMagic(head([0x25, 0x50, 0x44, 0x46]), "application/x-msdownload")).toBe(false)
  })

  it("fails closed on a header too short to cover the signature (no throw)", () => {
    // Only 4 bytes: the WebP RIFF segment matches but the offset-8 WEBP segment
    // reads past the end (undefined !== 0x57), so it fails to match rather than
    // throwing — the real risk for a tiny uploaded file.
    expect(matchesMagic(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "image/webp")).toBe(false)
  })
})
