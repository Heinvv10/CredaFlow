/**
 * An upload's body read with a cap: the declared Content-Length is checked
 * first, then the stream is counted as it arrives, so an oversized upload is
 * refused without being buffered whole (req.formData() would read it all).
 */
import { MAX_GUIDE_BYTES } from "./csv"

/** The file's limit plus room for the multipart envelope and the other fields. */
export const MAX_GUIDE_UPLOAD_BYTES = MAX_GUIDE_BYTES + 64 * 1024

export const UPLOAD_TOO_LARGE = "The upload is larger than 5 MB"

/** The body's bytes, or null once it passes `max`. */
export async function readCappedBody(req: Request, max = MAX_GUIDE_UPLOAD_BYTES): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** The capped body parsed as the multipart form it was sent as; null when it is not one. */
export async function formOf(req: Request, body: Uint8Array): Promise<FormData | null> {
  return new Response(Buffer.from(body), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData().catch(() => null)
}
