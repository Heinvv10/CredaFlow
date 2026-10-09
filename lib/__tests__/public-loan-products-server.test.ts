import { describe, it, expect, vi, beforeEach } from "vitest"

// This module is SERVER-ONLY (it imports prisma), so the client is mocked.
const findMany = vi.fn()
vi.mock("@/lib/prisma", () => ({ prisma: { loanProduct: { findMany: () => findMany() } } }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: async () => "tenant-1" }))
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react")
  return { ...actual, cache: <T,>(fn: T) => fn }
})

import { getLivePricingServer } from "../public-loan-products-server"

// The DB row for the live "30-Day Micro Loan". Deliberately configured to
// DISAGREE with the static catalogue snapshot on both discriminators, because a
// field that is selected but never copied across is invisible when the live and
// static values happen to match.
const MICRO30_ROW = {
  code: "MICRO30",
  interestRatePm: 0.05,
  interestModel: "DAILY_ACCRUAL",
  initiationFeeModel: "FLAT_PCT",
  initiationFeePct: 0.05,
  initiationFeeMax: 100000,
  monthlyServiceFee: 6900,
  productType: "PO_FUNDING",
  minAmount: 200000,
  maxAmount: 1000000,
  minTermDays: 30,
  maxTermDays: 30,
}

beforeEach(() => {
  findMany.mockReset()
})

describe("the server pricing read carries EVERY selected column", () => {
  // Regression: `initiationFeeModel` and `productType` were both present in the
  // Prisma `select` and both silently dropped from the mapped object, so every
  // server-rendered marketing page fell back to the compile-time catalogue —
  // losing the PO_FUNDING fee-cap exemption and publishing a fee basis the
  // engine does not use. Selecting a column is not reading it, and TypeScript
  // cannot catch it because these fields are optional on LivePricing.

  it("returns the LIVE fee model, not the static default", async () => {
    findMany.mockResolvedValue([MICRO30_ROW])
    const pricing = await getLivePricingServer("tenant-1")
    expect(pricing["short-term"]?.initiationFeeModel).toBe("FLAT_PCT")
  })

  it("returns the LIVE product category, not the static default", async () => {
    findMany.mockResolvedValue([MICRO30_ROW])
    const pricing = await getLivePricingServer("tenant-1")
    expect(pricing["short-term"]?.productType).toBe("PO_FUNDING")
  })

  it("drops no selected column on the way out", async () => {
    // Guards the NEXT field somebody adds to the select and forgets to map.
    findMany.mockResolvedValue([MICRO30_ROW])
    const pricing = await getLivePricingServer("tenant-1")
    const live = pricing["short-term"]
    expect(live).toBeDefined()
    for (const key of Object.keys(MICRO30_ROW)) {
      if (key === "code") continue // the code becomes the map key, not a value
      expect(Object.prototype.hasOwnProperty.call(live, key)).toBe(true)
    }
  })

  it("matches the product code case-insensitively", async () => {
    findMany.mockResolvedValue([{ ...MICRO30_ROW, code: "micro30" }])
    const pricing = await getLivePricingServer("tenant-1")
    expect(pricing["short-term"]?.initiationFeePct).toBe(0.05)
  })

  it("fails OPEN to the static catalogue when the read throws", async () => {
    findMany.mockRejectedValue(new Error("db down"))
    await expect(getLivePricingServer("tenant-1")).resolves.toEqual({})
  })
})
