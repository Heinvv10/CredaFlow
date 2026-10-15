import { describe, expect, it } from "vitest"
import { readJsonBody } from "./body"

// Review repro B4: the 16 KB cap was checked after `req.text()` had read the
// whole body, so a chunked body with no Content-Length was buffered in full.
function streamed(chunk: Uint8Array, opts: { chunks?: number; contentLength?: string } = {}) {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.chunks !== undefined && sent >= opts.chunks) return controller.close()
      sent++
      controller.enqueue(chunk)
    },
  })
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (opts.contentLength) headers["content-length"] = opts.contentLength
  const req = new Request("http://localhost/api/v1/applications", { method: "POST", body: stream, headers, duplex: "half" } as RequestInit)
  return { req, sent: () => sent }
}

describe("readJsonBody", () => {
  it("stops reading an endless chunked body just past the cap, whatever Content-Length says", async () => {
    const { req, sent } = streamed(new Uint8Array(1024).fill(0x20), { contentLength: "10" })
    const res = await readJsonBody(req, 16 * 1024)
    expect(res instanceof Response && res.status).toBe(413)
    expect(sent()).toBeLessThanOrEqual(18)
  })

  it("refuses a declared Content-Length over the cap without reading", async () => {
    const { req, sent } = streamed(new Uint8Array(10), { contentLength: String(20 * 1024) })
    const res = await readJsonBody(req, 16 * 1024)
    expect(res instanceof Response && res.status).toBe(413)
    expect(sent()).toBeLessThanOrEqual(1)
  })

  it("parses a small body and refuses one that is not JSON", async () => {
    const ok = await readJsonBody(new Request("http://localhost/", { method: "POST", body: JSON.stringify({ a: 1 }) }), 1024)
    expect(ok).toEqual({ value: { a: 1 } })
    const bad = await readJsonBody(new Request("http://localhost/", { method: "POST", body: "{" }), 1024)
    expect(bad instanceof Response && bad.status).toBe(400)
  })
})
