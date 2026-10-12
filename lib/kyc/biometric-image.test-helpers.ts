import { crc32, deflateSync } from "node:zlib"

/**
 * A 74-byte interlaced 1-bit PNG whose header claims side x side pixels (the
 * breaker's 16383 px case is ~268 MP). Its body is a stub: a decoder that
 * honours the pixel limit refuses on the header alone.
 */
export function oversizedPng(side: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  header.set([1, 0, 0, 0, 1], 8) // bit depth 1, greyscale, interlaced
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(1024))), chunk("IEND", Buffer.alloc(0)),
  ])
}
