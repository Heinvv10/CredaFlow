import { describe, expect, it } from "vitest"
import { ASSET_FREEING_DEAL_STATUSES, assetBookStatus } from "./asset-labels"
import { CLOSED_DEAL_STATUSES } from "./deal-create"
import { defaultUsageUnit } from "./lease-input"

describe("assetBookStatus (Fair Score audit E4)", () => {
  it("a new asset with no deal is available, not on book", () => {
    expect(assetBookStatus({ releasedAt: null, deals: [] })).toBe("Available")
  })

  it("an asset whose only deals closed is available again", () => {
    expect(assetBookStatus({ releasedAt: null, deals: [{ status: "DECLINED" }, { status: "CANCELLED" }, { status: "REFUSED_NCA" }] })).toBe("Available")
  })

  it("an asset on an open deal says so; a booked deal puts it on book; a release wins", () => {
    expect(assetBookStatus({ releasedAt: null, deals: [{ status: "DECLINED" }, { status: "SUBMITTED" }] })).toBe("On a deal (Submitted)")
    expect(assetBookStatus({ releasedAt: null, deals: [{ status: "BOOKED" }] })).toBe("On book")
    expect(assetBookStatus({ releasedAt: "16 Oct 2026", deals: [{ status: "BOOKED" }] })).toBe("Released 16 Oct 2026")
  })

  it("the client-safe list of asset-freeing statuses is the create route's list", () => {
    expect([...ASSET_FREEING_DEAL_STATUSES].sort()).toEqual([...CLOSED_DEAL_STATUSES].sort())
  })
})

describe("defaultUsageUnit (Fair Score audit E4)", () => {
  it("road vehicles default to km, machinery to hours", () => {
    for (const vehicle of ["PASSENGER_VEHICLE", "LIGHT_COMMERCIAL", "TRUCK", "TRAILER"] as const) expect(defaultUsageUnit(vehicle)).toBe("KM")
    for (const machine of ["TRACTOR", "TLB", "EXCAVATOR", "GRADER", "FRONT_END_LOADER", "FORKLIFT", "OTHER_YELLOW"] as const) expect(defaultUsageUnit(machine)).toBe("HOURS")
  })
})
