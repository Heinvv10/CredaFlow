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
 * EXIF orientation applied (and the tag dropped), long edge at most 2048 px,
 * flattened on white, sRGB, JPEG; at most 8 MiB.
 */
export async function canonicalBiometricImage(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<{ ok: true; image: CanonicalBiometricImage } | { ok: false; error: string }> {
  const page = await documentImage(fileBuffer, mimeType)
  if (!page.ok) return { ok: false, error: page.error }
  try {
    const jpeg = await sharp(page.buffer)
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
  } catch {
    return { ok: false, error: "The image could not be decoded" }
  }
}
