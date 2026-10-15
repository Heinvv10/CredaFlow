import { apiError } from "@/lib/lender-api/handler"

/**
 * Read a JSON request body of at most `maxBytes`, counting bytes as they
 * arrive and cancelling the stream as soon as the count passes the cap. The
 * Content-Length header is not trusted (it may be absent, as with chunked
 * transfer, or wrong): only the bytes actually read count.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<{ value: unknown } | Response> {
  const tooLarge = () => apiError(413, "body_too_large", `The body is larger than ${maxBytes} bytes.`)
  const declared = Number(req.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge()
  if (!req.body) return apiError(400, "invalid_body", "Send a JSON body.")

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel("body too large")
      return tooLarge()
    }
    chunks.push(value)
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  } catch {
    return apiError(400, "invalid_body", "Send a JSON body.")
  }
}
