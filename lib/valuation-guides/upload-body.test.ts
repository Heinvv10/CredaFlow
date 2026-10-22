import { describe, expect, it } from "vitest"
import { formOf, readCappedBody } from "./upload-body"

const streamed = (bytes: number, chunk = 1024) => new Request("http://x.test/", {
  method: "POST",
  body: new ReadableStream({
    start(controller) {
      for (let sent = 0; sent < bytes; sent += chunk) controller.enqueue(new Uint8Array(Math.min(chunk, bytes - sent)))
      controller.close()
    },
  }),
  // @ts-expect-error Node's fetch needs duplex for a streamed body
  duplex: "half",
})

describe("readCappedBody", () => {
  it("refuses a declared Content-Length over the cap without reading", async () => {
    const req = new Request("http://x.test/", { method: "POST", body: "x".repeat(20), headers: { "content-length": "20" } })
    expect(await readCappedBody(req, 10)).toBeNull()
    expect(req.bodyUsed).toBe(false)
  })

  it("stops a stream with no length as soon as it passes the cap", async () => {
    expect(await readCappedBody(streamed(5000), 4096)).toBeNull()
    expect((await readCappedBody(streamed(4096), 4096))?.byteLength).toBe(4096)
  })

  it("hands back a multipart body that reads as the form it was", async () => {
    const form = new FormData()
    form.set("name", "TEST Guide")
    const req = new Request("http://x.test/", { method: "POST", body: form })
    const body = await readCappedBody(req.clone(), 1_000_000)
    expect((await formOf(req, body!))?.get("name")).toBe("TEST Guide")
    expect(await formOf(new Request("http://x.test/", { method: "POST", body: "not a form" }), new TextEncoder().encode("not a form"))).toBeNull()
  })
})
