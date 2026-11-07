/**
 * The resized copies the website actually serves. An upload may be 3 MB and
 * 6000 px wide; a hero that large costs a phone seconds of LCP, so each upload
 * is decoded once (which also proves it is a real image, not just a header) and
 * re-encoded as WebP at two widths, 800 and 1920 px, never enlarged. Orientation
 * from the camera is applied and all metadata (EXIF, GPS) is dropped, so the
 * public copies carry nothing but pixels. The original stays on disk only so the
 * audit trail's hash still names a file.
 */
import sharp from "sharp"
import { IMAGERY_MAX_DIMENSION } from "./website-imagery-schema"

export const VARIANT_WIDTHS = [800, 1920] as const
export type VariantWidth = (typeof VARIANT_WIDTHS)[number]
export const LARGEST_VARIANT: VariantWidth = 1920
export const VARIANT_QUALITY = 80

export type Variants = { ok: true; files: Record<VariantWidth, Buffer>; width: number; height: number } | { ok: false; error: string }

export function isVariantWidth(value: number): value is VariantWidth {
  return (VARIANT_WIDTHS as readonly number[]).includes(value)
}

export async function makeVariants(bytes: Uint8Array): Promise<Variants> {
  try {
    const encode = (width: number) =>
      sharp(bytes, { limitInputPixels: IMAGERY_MAX_DIMENSION * IMAGERY_MAX_DIMENSION, failOn: "error" })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: VARIANT_QUALITY })
        .toBuffer({ resolveWithObject: true })
    const [small, large] = await Promise.all(VARIANT_WIDTHS.map(encode))
    return { ok: true, files: { 800: small.data, 1920: large.data }, width: large.info.width, height: large.info.height }
  } catch {
    return { ok: false, error: "The image could not be read; export it again as a JPEG, PNG or WebP file." }
  }
}
