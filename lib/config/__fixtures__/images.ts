/**
 * Header-faithful JPEG and WebP files for the website-imagery tests: the
 * markers and chunks the size is read from are real, the pixel data is filler
 * (the validator reads headers and never decodes). PNGs come from ./png.
 */

/** A JPEG whose frame header (SOF) declares width x height; `sof` picks baseline (0xc0) or progressive (0xc2). */
export function makeJpeg(width: number, height: number, opts: { sof?: number; padding?: number } = {}): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]) // shares the SOF range; carries no size
  const sof = Buffer.alloc(19)
  sof.set([0xff, opts.sof ?? 0xc0, 0x00, 0x11, 0x08])
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof.set([0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 9)
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, sof, sos, Buffer.alloc(opts.padding ?? 32, 0x55), Buffer.from([0xff, 0xd9])])
}

type WebpKind = "lossy" | "lossless" | "extended"

/** A WebP whose header declares width x height, in the lossy (VP8), lossless (VP8L) or extended (VP8X) layout. */
export function makeWebp(width: number, height: number, opts: { kind?: WebpKind; animated?: boolean; padding?: number } = {}): Buffer {
  const kind = opts.kind ?? "lossy"
  let chunk: Buffer
  if (kind === "lossy") {
    chunk = Buffer.alloc(18)
    chunk.write("VP8 ", 0, "latin1")
    chunk.writeUInt32LE(10, 4)
    chunk.set([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a], 8)
    chunk.writeUInt16LE(width, 14)
    chunk.writeUInt16LE(height, 16)
  } else if (kind === "lossless") {
    chunk = Buffer.alloc(13)
    chunk.write("VP8L", 0, "latin1")
    chunk.writeUInt32LE(5, 4)
    chunk[8] = 0x2f
    chunk.writeUInt32LE((width - 1 + ((height - 1) << 14)) >>> 0, 9)
  } else {
    chunk = Buffer.alloc(18)
    chunk.write("VP8X", 0, "latin1")
    chunk.writeUInt32LE(10, 4)
    chunk[8] = opts.animated ? 0x02 : 0x00
    chunk.writeUIntLE(width - 1, 12, 3)
    chunk.writeUIntLE(height - 1, 15, 3)
  }
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), chunk, Buffer.alloc(opts.padding ?? 32)])
  const riff = Buffer.alloc(8)
  riff.write("RIFF", 0, "latin1")
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}
