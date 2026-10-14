import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"

// A receiver that answers its status line and then trickles its body one byte
// at a time: every byte resets a socket idle timeout, so only postWebhook's
// overall deadline ends it. https.request is replaced by a fake that does exactly that.
const fake = vi.hoisted(() => ({ destroyed: false }))
vi.mock("node:https", () => {
  const request = (_url: unknown, _opts: unknown, onResponse: (res: EventEmitter & { statusCode: number; destroy: () => void }) => void) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: (err?: Error) => { fake.destroyed = true; if (err) req.emit("error", err) },
      end: () => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200, destroy: () => undefined })
        setTimeout(() => onResponse(res), 5)
        const drip = setInterval(() => (fake.destroyed ? clearInterval(drip) : res.emit("data", Buffer.from("x"))), 20)
      },
    })
    return req
  }
  return { default: { request } }
})

import { postWebhook } from "./post"

describe("postWebhook deadline", () => {
  it("ends a trickling response at the deadline instead of waiting for it", async () => {
    const started = Date.now()
    const result = await postWebhook("https://hooks.example.com/x", "{}", {}, {
      resolve: async () => [{ address: "93.184.215.14", family: 4 }],
      timeoutMs: 300,
    })
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(290)
    expect(took).toBeLessThan(2_000)
    expect(result).toEqual({ ok: false, status: null, error: "timed out after 300 ms", attempted: true })
    expect(fake.destroyed).toBe(true)
  })
})
