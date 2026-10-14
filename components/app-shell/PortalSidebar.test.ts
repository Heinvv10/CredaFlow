import { describe, expect, it } from "vitest"
import { buildPortalNavigation } from "@/lib/navigation"
import { portalMobileItems } from "./PortalSidebar"

describe("portalMobileItems (portal bottom nav on a phone)", () => {
  it("shows the five standard items to a consumer client", () => {
    expect(portalMobileItems(false).map((i) => i.href)).toEqual([
      "/portal", "/portal/applications", "/portal/documents", "/portal/payment", "/portal/profile",
    ])
  })

  it("adds Business, second, for a client who may act for an entity", () => {
    const items = portalMobileItems(true)
    expect(items.map((i) => i.href)).toEqual([
      "/portal", "/portal/business", "/portal/applications", "/portal/documents", "/portal/payment", "/portal/profile",
    ])
    expect(items[1].label).toBe("Business")
  })

  it("uses the same Business link as the desktop sidebar", () => {
    const desktop = buildPortalNavigation(null, { business: true }).find((i) => i.href === "/portal/business")
    expect(portalMobileItems(true)[1]).toEqual(desktop)
    expect(buildPortalNavigation(null).some((i) => i.href === "/portal/business")).toBe(false)
  })
})
