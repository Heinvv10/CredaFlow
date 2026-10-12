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

/** EXIF orientation applied (and the tag dropped), flattened on white, sRGB, JPEG. */
export async function canonicalBiometricImage(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<{ ok: true; image: CanonicalBiometricImage } | { ok: false; error: string }> {
  const page = await documentImage(fileBuffer, mimeType)
  if (!page.ok) return { ok: false, error: page.error }
  try {
    const jpeg = await sharp(page.buffer)
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      // 4:4:4 so the re-encode does not halve the colour detail either judge sees.
      .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
      .toBuffer()
    return {
      ok: true,
      image: { fileBuffer: jpeg, mimeType: "image/jpeg", sha256: createHash("sha256").update(jpeg).digest("hex") },
    }
  } catch {
    return { ok: false, error: "The image could not be decoded" }
  }
}
