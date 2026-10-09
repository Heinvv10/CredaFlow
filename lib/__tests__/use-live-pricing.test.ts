import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchLivePricing } from "../use-live-pricing"

// The shared live-pricing fetch MUST fail open: every public client surface
// (calculator, apply form, qualify wizard) overlays the result onto the static
// catalogue, so a dead/erroring API must yield {} — never throw, never a blank
// page. These pin that contract.

const SAMPLE = {
  "short-term": {
    interestRatePm: 0.05,
    interestModel: "FLAT" as const,
    initiationFeePct: 0.15,
    initiationFeeMax: 100000,
    monthlyServiceFee: 6900,
    minAmount: 50000,
    maxAmount: 1000000,
    minTermDays: 30,
    maxTermDays: 30,
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchLivePricing is fail-open", () => {
  it("returns the pricing map on a 200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ pricing: SAMPLE }) })))
    await expect(fetchLivePricing()).resolves.toEqual(SAMPLE)
  })

  it("returns {} on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ pricing: SAMPLE }) })))
    await expect(fetchLivePricing()).resolves.toEqual({})
  })

  it("returns {} when fetch rejects (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down")
    }))
    await expect(fetchLivePricing()).resolves.toEqual({})
  })

  it("returns {} when the response body has no pricing key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    await expect(fetchLivePricing()).resolves.toEqual({})
  })

  it("returns {} when the response body is null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => null })))
    await expect(fetchLivePricing()).resolves.toEqual({})
  })
})
