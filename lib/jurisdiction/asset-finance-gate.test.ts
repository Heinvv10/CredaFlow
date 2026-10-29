import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const findUnique = vi.fn()
let lookupFails = false
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: {
      findUnique: async (...a: unknown[]) => {
        if (lookupFails) throw new Error("database unavailable")
        return findUnique(...a)
      },
    },
  },
}))
vi.mock("next/headers", () => ({ headers: vi.fn() }))
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }))

import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { resetActiveJurisdiction, setActiveJurisdiction } from "./active"

beforeEach(() => { findUnique.mockReset(); lookupFails = false })
afterEach(() => resetActiveJurisdiction())

const flags = (featureAssetFinance: boolean) => ({ featureCrm: false, featureIms: false, featureAssetFinance })

describe("requireAssetFinanceEnabled (the gate behind every asset-finance route)", () => {
  it("answers 404 when the lender's flag is off", async () => {
    findUnique.mockResolvedValue(flags(false))
    expect((await requireAssetFinanceEnabled("t1"))?.status).toBe(404)
  })

  it("lets a ZA lender with the flag on through", async () => {
    findUnique.mockResolvedValue(flags(true))
    expect(await requireAssetFinanceEnabled("t1")).toBeNull()
  })

  it("answers 404 for an LS lender even when the column says on", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    findUnique.mockResolvedValue(flags(true))
    expect((await requireAssetFinanceEnabled("t1"))?.status).toBe(404)
  })

  it("fails closed when the lookup throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    lookupFails = true
    let result: Awaited<ReturnType<typeof requireAssetFinanceEnabled>> | undefined
    try {
      result = await requireAssetFinanceEnabled("t1")
    } catch (error) {
      throw new Error(`the gate threw instead of failing closed: ${String(error)}`)
    }
    expect(result?.status).toBe(404)
  })
})
