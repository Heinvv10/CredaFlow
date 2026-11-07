/**
 * Reads what an uploaded image really is from its own bytes (never from a file
 * name or a declared type): JPEG, PNG or static WebP, its pixel size, and that
 * it is within the limits. Header parsing only, so nothing is decoded and a
 * small file that declares a huge image is refused before anything inflates it.
 */
import { IMAGERY_MAX_BYTES, IMAGERY_MAX_DIMENSION, type ImageFormat } from "./website-imagery-schema"

export type ImageInspection =
  | { ok: true; format: ImageFormat; mime: string; width: number; height: number }
  | { ok: false; error: string }

export const IMAGE_MIME: Record<ImageFormat, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }
export const IMAGE_EXTENSION: Record<ImageFormat, string> = { jpeg: "jpg", png: "png", webp: "webp" }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const NOT_AN_IMAGE = "The image must be a JPEG, PNG or WebP file."
const UNREADABLE = "The image could not be read; export it again as a JPEG, PNG or WebP file."

type Size = { width: number; height: number } | null

function pngSize(b: Buffer): Size {
  if (b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

// SOF markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(b: Buffer): Size {
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) { i += 1; continue } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue } // no length
    const length = b.readUInt16BE(i + 2)
    if (length < 2) return null
    if (SOF.has(marker)) {
      if (i + 9 > b.length) return null
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    if (marker === 0xda) return null // start of scan reached with no frame header
    i += 2 + length
  }
  return null
}

function webpSize(b: Buffer): Size | "animated" {
  if (b.length < 30) return null
  const chunk = b.toString("latin1", 12, 16)
  if (chunk === "VP8X") {
    if (b[20] & 0x02) return "animated"
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null
    const bits = b.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  return null
}

export function inspectImage(bytes: Uint8Array): ImageInspection {
  if (bytes.length > IMAGERY_MAX_BYTES) return { ok: false, error: `The image must be at most ${IMAGERY_MAX_BYTES / (1024 * 1024)} MB.` }
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  let format: ImageFormat
  let size: Size | "animated"
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) {
    format = "png"
    size = pngSize(b)
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    format = "jpeg"
    size = jpegSize(b)
  } else if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    format = "webp"
    size = webpSize(b)
  } else {
    return { ok: false, error: NOT_AN_IMAGE }
  }
  if (size === "animated") return { ok: false, error: "Animated WebP is not supported; upload a still image." }
  if (!size || size.width < 1 || size.height < 1) return { ok: false, error: UNREADABLE }
  if (size.width > IMAGERY_MAX_DIMENSION || size.height > IMAGERY_MAX_DIMENSION) {
    return { ok: false, error: `The image must be at most ${IMAGERY_MAX_DIMENSION}×${IMAGERY_MAX_DIMENSION} pixels.` }
  }
  return { ok: true, format, mime: IMAGE_MIME[format], width: size.width, height: size.height }
}
