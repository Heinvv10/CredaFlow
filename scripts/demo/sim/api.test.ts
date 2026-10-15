import { afterEach, describe, expect, it, vi } from "vitest"

import { SimClient } from "./api"

function ok(): Response {
  return new Response("{}", { headers: { "content-type": "application/json" } })
}

afterEach(() => vi.unstubAllGlobals())

describe("SimClient browser request metadata", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("sends the app's Origin on %s", async (method) => {
    const fetch = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal("fetch", fetch)

    await new SimClient("http://127.0.0.1:3320").request(method, "/api/example")

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3320/api/example",
      expect.objectContaining({ headers: expect.objectContaining({ origin: "http://127.0.0.1:3320" }) }),
    )
  })

  it.each(["GET", "HEAD", "OPTIONS"])("does not invent an Origin on %s", async (method) => {
    const fetch = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal("fetch", fetch)

    await new SimClient("http://127.0.0.1:3320").request(method, "/api/example")

    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("origin")
  })
})
