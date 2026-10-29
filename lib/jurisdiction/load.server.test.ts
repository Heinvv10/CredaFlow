import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const findMany = vi.fn()
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findMany: (...a: unknown[]) => findMany(...a) } } }))

import { activeCurrency, activeJurisdiction, resetActiveJurisdiction } from "./active"
import { ensureActiveJurisdiction, loadActiveJurisdiction, resetEnsuredJurisdiction } from "./load.server"

const original = process.env.NEXT_PUBLIC_TENANT_SLUG

beforeEach(() => {
  findMany.mockReset()
  delete process.env.NEXT_PUBLIC_TENANT_SLUG
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  resetActiveJurisdiction()
  resetEnsuredJurisdiction()
  if (original === undefined) delete process.env.NEXT_PUBLIC_TENANT_SLUG
  else process.env.NEXT_PUBLIC_TENANT_SLUG = original
  vi.restoreAllMocks()
})

describe("loadActiveJurisdiction", () => {
  it("adopts the only active tenant's jurisdiction and currency", async () => {
    findMany.mockResolvedValue([{ jurisdiction: "LS", currency: "LSL" }])
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "LS", currency: "LSL" })
    expect(activeJurisdiction()).toBe("LS")
    expect(activeCurrency()).toBe("LSL")
    expect(findMany.mock.calls[0][0].where).toEqual({ tenant: { status: "ACTIVE" } })
  })

  it("reads the tenant named by NEXT_PUBLIC_TENANT_SLUG when it is set", async () => {
    process.env.NEXT_PUBLIC_TENANT_SLUG = "lpb-demo"
    findMany.mockResolvedValue([{ jurisdiction: "LS", currency: "LSL" }])
    await loadActiveJurisdiction()
    expect(findMany.mock.calls[0][0].where).toEqual({ tenant: { slug: "lpb-demo" } })
  })

  it("keeps ZA (NCA gates on) when several tenants are active and no slug picks one", async () => {
    findMany.mockResolvedValue([{ jurisdiction: "LS", currency: "LSL" }, { jurisdiction: "ZA", currency: "ZAR" }])
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
  })

  it("keeps ZA and logs when the read fails, rather than throwing into the layout", async () => {
    findMany.mockRejectedValue(new Error("db down"))
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(console.error).toHaveBeenCalled()
  })

  it("keeps ZA when the stored value is not a known code", async () => {
    findMany.mockResolvedValue([{ jurisdiction: "XX", currency: "ZAR" }])
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(console.error).toHaveBeenCalled()
  })
})

describe("ensureActiveJurisdiction", () => {
  it("queries once per process once the lender is known, even for ZA", async () => {
    findMany.mockResolvedValue([{ jurisdiction: "ZA", currency: "ZAR" }])
    await ensureActiveJurisdiction()
    await ensureActiveJurisdiction()
    expect(findMany).toHaveBeenCalledTimes(1)
  })

  it("tries again after a failed or empty read", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ jurisdiction: "LS", currency: "LSL" }])
    await ensureActiveJurisdiction()
    const second = await ensureActiveJurisdiction()
    expect(second.jurisdiction).toBe("LS")
    expect(findMany).toHaveBeenCalledTimes(2)
  })
})
