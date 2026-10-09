import { describe, it, expect, vi, afterEach } from "vitest"
import { loadLoanNotes } from "./loan-notes"

describe("loadLoanNotes", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves with parsed data on a 200 response", async () => {
    const body = [{
      id: "n1", type: "general", note: "Called client", documentId: null,
      createdBy: "agent@acme-lending.example", createdAt: "2026-01-01",
    }]
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))
    await expect(loadLoanNotes("loan-1")).resolves.toEqual(body)
  })

  it("rejects on a non-OK response instead of returning the error body as data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })))
    await expect(loadLoanNotes("loan-1")).rejects.toThrow("Failed to load notes")
  })

  it("rejects when the network request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    await expect(loadLoanNotes("loan-1")).rejects.toThrow()
  })
})
