import { describe, it, expect, vi, afterEach } from "vitest"
import { loadInsurers } from "./settings-insurers"

describe("loadInsurers", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves with parsed data on a 200 response", async () => {
    const body = [{
      id: "i1", name: "Old Mutual", fspNumber: "FSP 12345", contactName: null,
      contactEmail: null, contactPhone: null, apiEndpoint: null, active: true, createdAt: "2026-01-01",
    }]
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))
    await expect(loadInsurers()).resolves.toEqual(body)
  })

  it("rejects on a non-OK response instead of returning the error body as data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })))
    await expect(loadInsurers()).rejects.toThrow("Failed to load insurers")
  })

  it("rejects when the network request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    await expect(loadInsurers()).rejects.toThrow()
  })
})
