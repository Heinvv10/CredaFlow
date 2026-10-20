import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { callCronRoute } from "./cron-call"

let server: http.Server | undefined
const listen = async (handler: http.RequestListener): Promise<string> => {
  server = http.createServer(handler)
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cron/x`
}
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

describe("callCronRoute", () => {
  it("sends the method and the cron secret, and returns the status and the JSON body", async () => {
    let seen: { method?: string; secret?: string | string[] } = {}
    const url = await listen((req, res) => {
      seen = { method: req.method, secret: req.headers["x-cron-secret"] }
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ failedTenants: 2 }))
    })
    expect(await callCronRoute(url, "POST", "s3cret")).toEqual({ status: 503, body: { failedTenants: 2 } })
    expect(seen).toEqual({ method: "POST", secret: "s3cret" })
  })

  it("returns a null body for a response that is not JSON, rather than failing the call", async () => {
    const url = await listen((_req, res) => void res.writeHead(200).end("ok"))
    expect(await callCronRoute(url, "GET", "s")).toEqual({ status: 200, body: null })
  })

  it("waits for a slow run: no client-side timeout (undici's fetch gives up on headers after 300 s)", async () => {
    const url = await listen((_req, res) => {
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"failedTenants":0}'), 1500)
    })
    const started = Date.now()
    expect(await callCronRoute(url, "GET", "s")).toEqual({ status: 200, body: { failedTenants: 0 } })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
  })

  it("rejects when the connection fails", async () => {
    await expect(callCronRoute("http://127.0.0.1:1/api/cron/x", "GET", "s")).rejects.toThrow()
  })
})
