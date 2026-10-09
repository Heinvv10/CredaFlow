import { crc32, deflateSync } from "node:zlib"
import { randomBytes } from "node:crypto"

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * A real RGB PNG of the given size, for logo tests. `noise` fills it with
 * random pixels so it does not compress (to build an oversize file).
 */
export function makePng(width: number, height: number, opts: { noise?: boolean; rgb?: [number, number, number] } = {}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  const [r, g, b] = opts.rgb ?? [200, 40, 40]
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = opts.noise ? randomBytes(width * 3) : Buffer.alloc(width * 3)
    if (!opts.noise) for (let x = 0; x < width; x++) row.set([r, g, b], x * 3)
    rows.push(Buffer.concat([Buffer.from([0]), row]))
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
