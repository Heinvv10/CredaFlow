import http from "node:http"
import net from "node:net"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const observeHttpRequest = vi.hoisted(() => vi.fn())
vi.mock("./metrics", () => ({ observeHttpRequest }))

import { instrumentHttpServer } from "./http-metrics"

let server: http.Server
let port: number
const closed = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

beforeAll(async () => {
  instrumentHttpServer()
  server = http.createServer((req, res) => {
    if (req.url?.startsWith("/teapot")) {
      res.statusCode = 418
      res.end("short and stout")
    } else if (req.url?.startsWith("/hang")) {
      res.write("partial")
      // never ends: the client goes away
    } else {
      res.end("ok")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const get = (path: string, method = "GET") =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, agent: false }, (res) => {
      res.resume()
      res.on("end", () => resolve(res.statusCode ?? 0))
    })
    req.on("error", reject)
    req.end()
  })

describe("instrumentHttpServer", () => {
  it("counts a request with its method, path (query dropped), final status and a duration", async () => {
    observeHttpRequest.mockClear()
    await get("/teapot?secret=1", "POST")
    await closed()
    expect(observeHttpRequest).toHaveBeenCalledTimes(1)
    const [method, pathname, status, seconds] = observeHttpRequest.mock.calls[0]!
    expect([method, pathname, status]).toEqual(["POST", "/teapot", "418"])
    expect(seconds).toBeGreaterThanOrEqual(0)
    expect(seconds).toBeLessThan(5)
  })

  it("does not alter the response it observes", async () => {
    expect(await get("/anything")).toBe(200)
  })

  it.each(["/api/metrics", "/api/health/live", "/api/health/ready"])("does not count %s, so probes and scrapes stay out of the histogram", async (path) => {
    observeHttpRequest.mockClear()
    await get(path)
    await closed()
    expect(observeHttpRequest).not.toHaveBeenCalled()
  })

  it("counts /api/health: only the cheap probes and the scrape are excluded", async () => {
    observeHttpRequest.mockClear()
    await get("/api/health")
    await closed()
    expect(observeHttpRequest).toHaveBeenCalledTimes(1)
  })

  it("labels a response cut off before it finished as aborted", async () => {
    observeHttpRequest.mockClear()
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write("GET /hang HTTP/1.1\r\nHost: x\r\n\r\n"))
      socket.once("data", () => {
        socket.destroy()
        resolve()
      })
    })
    await closed()
    expect(observeHttpRequest).toHaveBeenCalledTimes(1)
    expect(observeHttpRequest.mock.calls[0]![2]).toBe("aborted")
  })

  it("patches the Server prototype once, however often it is installed", async () => {
    instrumentHttpServer()
    instrumentHttpServer()
    observeHttpRequest.mockClear()
    await get("/once")
    await closed()
    expect(observeHttpRequest).toHaveBeenCalledTimes(1)
  })
})
