import sharp from "sharp"

/**
 * A real, decodable image (the website-imagery write path decodes what it
 * stores). `orientation` writes an EXIF orientation tag, and `exif` adds a
 * GPS-free comment-style tag so a test can prove the served copy carries no metadata.
 */
export async function realImage(
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp" = "jpeg",
  opts: { rgb?: [number, number, number]; orientation?: number; withExif?: boolean } = {},
): Promise<Buffer> {
  const [r, g, b] = opts.rgb ?? [200, 120, 40]
  let image = sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
  if (opts.withExif || opts.orientation) {
    image = image.withExif({ IFD0: { Copyright: "Synthetic test photographer" } }).withMetadata({ orientation: opts.orientation })
  }
  return image[format]().toBuffer()
}
