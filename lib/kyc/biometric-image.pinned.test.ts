/**
 * The canonical biometric image is what both face judges see and what the
 * evidence row's SHA-256 names, so a libvips/sharp upgrade that changes a
 * single output byte must be noticed. These pins fail on any such change;
 * re-pin only with a proof that the face-model scores did not move.
 *
 * The inputs are synthetic (no face) and built without sharp, except the
 * committed EXIF-orientation JPEG, so an encoder change cannot move the input.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { beforeEach, describe, expect, it, vi } from "vitest"

const documentImageMock = vi.fn()
vi.mock("@/lib/vlm-extract", () => ({
  documentImage: (...args: unknown[]) => documentImageMock(...args),
}))

import { canonicalBiometricImage } from "./biometric-image.server"

beforeEach(() => {
  documentImageMock.mockImplementation(async (buffer: Buffer, mimeType: string) => ({ ok: true, buffer, mimeType }))
})

/** An 8-bit PNG (colour type 2 = RGB, 6 = RGBA) from a per-pixel function. */
function png(width: number, height: number, channels: 3 | 4, px: (x: number, y: number) => number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, channels === 3 ? 2 : 6, 0, 0, 0], 8)
  const rows = Buffer.alloc(height * (1 + width * channels))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * channels)
    for (let x = 0; x < width; x++) rows.set(px(x, y), row + 1 + x * channels)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ])
}

const cases: [string, () => Buffer, string, string][] = [
  [
    "an EXIF-rotated JPEG",
    () => readFileSync(join(__dirname, "__fixtures__", "biometric-orientation-6.jpg")),
    "image/jpeg",
    "b01e03ae387e8c79d1ce3148c9a3477810e22634a1665275b3c1f5d846d9d922",
  ],
  [
    "a transparent PNG flattened on white",
    () => png(64, 48, 4, (x, y) => [x * 4, y * 5, (x * y) & 0xff, (x + y) * 2]),
    "image/png",
    "1a2f796792a5efda3a6d00725fa0f5ec9a1dc9f2a075f19061d0c6c9a825c28e",
  ],
  [
    "a PNG above 2048 px, resized",
    () => png(2600, 1300, 3, (x, y) => [x & 0xff, y & 0xff, (x ^ y) & 0xff]),
    "image/png",
    "9679d71329717b4b82fd7ddb4c102c702ba3819def76835423a07ba37a33920e",
  ],
]

describe("canonical biometric image bytes", () => {
  it.each(cases)("are pinned for %s", async (_name, input, mimeType, sha256) => {
    const result = await canonicalBiometricImage(input(), mimeType)
    if (!result.ok) throw new Error(result.error)
    expect(result.image.sha256).toBe(sha256)
  })
})
