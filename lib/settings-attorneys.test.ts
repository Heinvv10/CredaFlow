import { describe, it, expect, vi, afterEach } from "vitest"
import { loadAttorneyFirms } from "./settings-attorneys"

describe("loadAttorneyFirms", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves with parsed data on a 200 response", async () => {
    const body = [{
      id: "f1", name: "Van der Merwe Attorneys", contactPerson: null, phone: null,
      email: null, address: null, specialisation: null, active: true, createdAt: "2026-01-01",
    }]
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))
    await expect(loadAttorneyFirms(false)).resolves.toEqual(body)
  })

  it("rejects on a non-OK response instead of returning the error body as data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })))
    await expect(loadAttorneyFirms(false)).rejects.toThrow("Failed to load attorney firms")
  })

  it("rejects when the network request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    await expect(loadAttorneyFirms(true)).rejects.toThrow()
  })
})
