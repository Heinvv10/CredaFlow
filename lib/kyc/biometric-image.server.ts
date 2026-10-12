/**
 * The one image each side of a selfie check is judged on. Both judges, the
 * VLM and the face model, receive these exact bytes: decoding the original
 * twice let them see different pixels (an RGBA PNG flattened one way for the
 * face model and another for a VLM that drops alpha; EXIF orientation applied
 * by one and not the other). A PDF ID is rendered once, by the page render
 * the VLM has always used.
 */
import { createHash } from "node:crypto"
import sharp from "sharp"
import { documentImage } from "@/lib/vlm-extract"

export type CanonicalBiometricImage = { fileBuffer: Buffer; mimeType: "image/jpeg"; sha256: string }

/**
 * The long edge both judges see: the face model decodes at most this much
 * (lib/kyc/face-model/compare.server.ts), so the VLM gets the same
 * resolution. Unbounded, a 1.5 MB 16000 px checkerboard PNG became a 66 MB
 * JPEG, about 88 MB of base64 to the shared VLM.
 */
export const CANONICAL_IMAGE_MAX_EDGE_PX = 2048
/**
 * At the cap a real photograph encodes to about 1-2 MB; random noise at
 * 2048x2048 reaches 8.07 MiB. Anything larger is refused.
 */
export const CANONICAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/**
 * Decoding happens before the cap, so the upload's own size bounds memory:
 * an interlaced 16383 px PNG or a progressive JPEG cost about 1 GB RSS each.
 * Phone photos are 12-50 MP (a 48 MP one peaks near 290 MB); larger is
 * refused from its header, in milliseconds. Shared with the face model's
 * decode (lib/kyc/face-model/compare.server.ts).
 */
export const MAX_INPUT_PIXELS = 50_000_000

/**
 * Canonicalisation runs in the background after the upload has answered, so
 * nothing in request handling bounds how many run at once. Four 1 GB decodes
 * at once would take a small container down for every tenant.
 */
export const MAX_CONCURRENT_CANONICALISATIONS = 2
/** A caller that cannot get a slot in this long is refused rather than queued without bound. */
export const CANONICALISATION_WAIT_TIMEOUT_MS = 30_000
let active = 0
const waiting: Array<() => void> = []

/**
 * A slot, or false after the wait timeout. A released slot passes straight
 * to the next waiter, so no third caller slips in; a waiter that times out
 * leaves the queue.
 */
function acquire(): Promise<boolean> {
  if (active < MAX_CONCURRENT_CANONICALISATIONS) {
    active++
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const granted = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(granted), 1)
      resolve(false)
    }, CANONICALISATION_WAIT_TIMEOUT_MS)
    waiting.push(granted)
  })
}

function release(): void {
  const next = waiting.shift()
  if (next) next()
  else active--
}

type CanonicalResult = { ok: true; image: CanonicalBiometricImage } | { ok: false; error: string }

/**
 * EXIF orientation applied (and the tag dropped), long edge at most 2048 px,
 * flattened on white, sRGB, JPEG; at most 8 MiB. Inputs above 50 MP are
 * refused, and at most two run at once (a PDF render included); a caller
 * waits at most 30 s for a slot.
 */
export async function canonicalBiometricImage(fileBuffer: Buffer, mimeType: string): Promise<CanonicalResult> {
  if (!(await acquire())) return { ok: false, error: "The image check is busy; no slot came free within 30 s" }
  try {
    return await canonicalise(fileBuffer, mimeType)
  } finally {
    release()
  }
}

async function canonicalise(fileBuffer: Buffer, mimeType: string): Promise<CanonicalResult> {
  const page = await documentImage(fileBuffer, mimeType)
  if (!page.ok) return { ok: false, error: page.error }
  try {
    const jpeg = await sharp(page.buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(CANONICAL_IMAGE_MAX_EDGE_PX, CANONICAL_IMAGE_MAX_EDGE_PX, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      // 4:4:4 so the re-encode does not halve the colour detail either judge sees.
      .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
      .toBuffer()
    if (jpeg.length > CANONICAL_IMAGE_MAX_BYTES) return { ok: false, error: "The prepared image is larger than 8 MiB" }
    return {
      ok: true,
      image: { fileBuffer: jpeg, mimeType: "image/jpeg", sha256: createHash("sha256").update(jpeg).digest("hex") },
    }
  } catch (error) {
    return error instanceof Error && /pixel limit/.test(error.message)
      ? { ok: false, error: "The image is larger than 50 megapixels" }
      : { ok: false, error: "The image could not be decoded" }
  }
}
