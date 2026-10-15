import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loan: { findFirst: mocks.findFirst } } }))

import { loadSurrenderRequestOpen, surrenderRequestOpen } from "./surrender-request-gate"

describe("surrenderRequestOpen", () => {
  it("is open on a loan with no recovery and a free asset", () => {
    expect(surrenderRequestOpen({ recoveryStatuses: [], lessorStatus: null })).toBe(true)
  })
  it("is closed while any recovery is not withdrawn", () => {
    for (const status of ["RECOVERED", "LISTED", "SOLD", "SHORTFALL_OPEN", "CLOSED"] as const) {
      expect(surrenderRequestOpen({ recoveryStatuses: [status], lessorStatus: null })).toBe(false)
    }
    expect(surrenderRequestOpen({ recoveryStatuses: ["WITHDRAWN", "LISTED"], lessorStatus: null })).toBe(false)
  })
  it("is open again once every recovery is withdrawn", () => {
    expect(surrenderRequestOpen({ recoveryStatuses: ["WITHDRAWN", "WITHDRAWN"], lessorStatus: null })).toBe(true)
  })
  it("is closed once the asset is recovered or sold in remarketing, even without a recovery row in sight", () => {
    expect(surrenderRequestOpen({ recoveryStatuses: [], lessorStatus: "RECOVERED" })).toBe(false)
    expect(surrenderRequestOpen({ recoveryStatuses: [], lessorStatus: "SOLD_IN_REMARKETING" })).toBe(false)
    expect(surrenderRequestOpen({ recoveryStatuses: [], lessorStatus: "RETURNED_TO_STOCK" })).toBe(true)
  })
})

describe("loadSurrenderRequestOpen", () => {
  it("reads the loan's recoveries and its asset's lessor status, tenant-scoped", async () => {
    mocks.findFirst.mockResolvedValue({ asset: { lessorStatus: null }, recoveries: [{ status: "LISTED" }] })
    expect(await loadSurrenderRequestOpen("t-1", "l-1")).toBe(false)
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "l-1", tenantId: "t-1" } }))
  })
  it("is closed for an unknown loan", async () => {
    mocks.findFirst.mockResolvedValue(null)
    expect(await loadSurrenderRequestOpen("t-1", "l-1")).toBe(false)
  })
})
