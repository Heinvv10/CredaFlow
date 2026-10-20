import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CALL_CEILING_MS, callCronRoute, cronCallTarget, FAILED_TENANTS_HEADER } from "./cron-call"

let server: http.Server | undefined
const listen = async (handler: http.RequestListener): Promise<string> => {
  server = http.createServer(handler)
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cron/x`
}
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

describe("callCronRoute", () => {
  it("sends the method and the cron secret, and returns the status and the JSON body", async () => {
    let seen: { method?: string; secret?: string | string[] } = {}
    const url = await listen((req, res) => {
      seen = { method: req.method, secret: req.headers["x-cron-secret"] }
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ partial: true }))
    })
    expect(await callCronRoute(url, "POST", "s3cret")).toEqual({ status: 503, body: { partial: true }, failedTenants: null })
    expect(seen).toEqual({ method: "POST", secret: "s3cret" })
  })

  it("returns a null body for a response that is not JSON, rather than failing the call", async () => {
    const url = await listen((_req, res) => void res.writeHead(200).end("ok"))
    expect((await callCronRoute(url, "GET", "s")).body).toBeNull()
  })

  // A body past the cap is dropped (body null), which reads like a success. The failed-tenant count
  // therefore travels in a header, which is never dropped.
  it("reads the failed-tenant count from the header, even when the body was too big to keep", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", [FAILED_TENANTS_HEADER]: "2" }).end(JSON.stringify({ details: "x".repeat(1_100_000) }))
    })
    expect(await callCronRoute(url, "GET", "s")).toEqual({ status: 200, body: null, failedTenants: 2 })
  })

  it.each([["0", 0], ["3", 3], ["", null], ["many", null], ["-1", null]])("reads the header %j as %j (anything that is not a count is no count)", async (value, expected) => {
    const url = await listen((_req, res) => void res.writeHead(200, { [FAILED_TENANTS_HEADER]: value }).end("{}"))
    expect((await callCronRoute(url, "GET", "s")).failedTenants).toBe(expected)
  })

  it("sends the public host as Host when asked: tenant resolution by domain still works on loopback", async () => {
    let host: string | undefined
    const url = await listen((req, res) => {
      host = req.headers.host
      res.writeHead(200).end("{}")
    })
    await callCronRoute(url, "GET", "s", { host: "staff.lender.example" })
    expect(host).toBe("staff.lender.example")
  })

  it("waits for a response that is slower than a second: it adds no timeout of its own below the ceiling", async () => {
    const url = await listen((_req, res) => {
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'), 1200)
    })
    const started = Date.now()
    expect((await callCronRoute(url, "GET", "s")).body).toEqual({ ok: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1100)
  })

  // The only timeout is a generous ceiling, so a route that hangs cannot keep the claim's heartbeat
  // (and with it the claim) alive for ever.
  it("gives up at its ceiling on a route that never answers", async () => {
    const url = await listen(() => undefined)
    const started = Date.now()
    await expect(callCronRoute(url, "GET", "s", { ceilingMs: 300 })).rejects.toThrow(/ceiling/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  // Two properties that no short test can observe directly, pinned where they are set.
  it("keeps a ceiling long enough for a real nightly run, and finite", () => {
    expect(CALL_CEILING_MS).toBeGreaterThanOrEqual(50 * 60_000)
    expect(CALL_CEILING_MS).toBeLessThanOrEqual(2 * 60 * 60_000)
  })

  it("opens a connection of its own (agent: false): a pooled socket's idle timeout cannot cut a long run", async () => {
    const url = await listen((_req, res) => void res.writeHead(200).end("{}"))
    const request = vi.spyOn(http, "request")
    try {
      await callCronRoute(url, "GET", "s")
      expect(request).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ agent: false }), expect.any(Function))
      expect(request.mock.calls[0][1]).not.toHaveProperty("timeout")
    } finally {
      request.mockRestore()
    }
  })

  it("rejects when the connection fails", async () => {
    await expect(callCronRoute("http://127.0.0.1:1/api/cron/x", "GET", "s")).rejects.toThrow()
  })
})

describe("cronCallTarget", () => {
  it("is this server on loopback at its own port, with the public host kept as Host", () => {
    expect(cronCallTarget({ NEXTAUTH_URL: "https://staff.lender.example", PORT: "3301" })).toEqual({ baseUrl: "http://127.0.0.1:3301", host: "staff.lender.example" })
  })

  it("defaults to the image's port 3300, and keeps a port in the public host", () => {
    expect(cronCallTarget({ NEXTAUTH_URL: "http://localhost:8443" })).toEqual({ baseUrl: "http://127.0.0.1:3300", host: "localhost:8443" })
  })

  it("has no Host to send when NEXTAUTH_URL is unset or unusable", () => {
    expect(cronCallTarget({})).toEqual({ baseUrl: "http://127.0.0.1:3300" })
    expect(cronCallTarget({ NEXTAUTH_URL: "not a url" })).toEqual({ baseUrl: "http://127.0.0.1:3300" })
  })

  it("takes CRON_BASE_URL as it is, without a trailing slash and without a Host of its own", () => {
    expect(cronCallTarget({ CRON_BASE_URL: "http://app:3300/", NEXTAUTH_URL: "https://staff.lender.example", PORT: "9" })).toEqual({ baseUrl: "http://app:3300" })
  })
})
