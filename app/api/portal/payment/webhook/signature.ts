import { createHmac, timingSafeEqual } from "node:crypto"

export function verifyStitchSignature(opts: {
  body: string
  signature: string
  secret: string
}): boolean {
  if (!opts.signature || !opts.secret) return false
  const expected = createHmac("sha256", opts.secret).update(opts.body).digest("hex")
  const expectedBuf = Buffer.from(expected, "utf8")
  const signatureBuf = Buffer.from(opts.signature, "utf8")
  if (expectedBuf.byteLength !== signatureBuf.byteLength) return false
  return timingSafeEqual(expectedBuf, signatureBuf)
}
