import { describe, it, expect } from "vitest"
import { groupEnabled, itemEnabled } from "./AppSidebar"
import type { NavGroup, NavItem } from "@/lib/navigation"
import type { UserRole } from "@/lib/permissions"

const icon = (() => null) as never

function item(minRole?: UserRole): NavItem {
  return { href: "/settings/users", label: "Users", icon, minRole }
}

describe("itemEnabled (sidebar nav role gate)", () => {
  it("denies a role below the item's minRole", () => {
    expect(itemEnabled(item("BRANCH_MANAGER"), "LOAN_ADMIN")).toBe(false)
  })

  it("allows BRANCH_MANAGER, ADMIN, and SUPER_ADMIN when minRole is BRANCH_MANAGER", () => {
    expect(itemEnabled(item("BRANCH_MANAGER"), "BRANCH_MANAGER")).toBe(true)
    expect(itemEnabled(item("BRANCH_MANAGER"), "ADMIN")).toBe(true)
    expect(itemEnabled(item("BRANCH_MANAGER"), "SUPER_ADMIN")).toBe(true)
  })

  it("allows any role when the item has no minRole", () => {
    expect(itemEnabled(item(undefined), "READONLY")).toBe(true)
    expect(itemEnabled(item(undefined), "COLLECTIONS_AGENT")).toBe(true)
  })

  it("denies an unrecognised role even against a gated item (fail-closed)", () => {
    expect(itemEnabled(item("BRANCH_MANAGER"), "UNKNOWN_FUTURE_ROLE" as UserRole)).toBe(false)
  })
})

describe("groupEnabled (sidebar nav feature gate)", () => {
  const group = (feature?: NavGroup["feature"]): NavGroup => ({ label: "G", items: [], feature })
  const off = { featureCrm: false, featureIms: false, featureBureauSubmission: false, featureAssetFinance: false }

  it("shows the bureau submission group only with featureBureauSubmission on", () => {
    expect(groupEnabled(group("bureauSubmission"), off)).toBe(false)
    expect(groupEnabled(group("bureauSubmission"), { ...off, featureCrm: true, featureIms: true })).toBe(false)
    expect(groupEnabled(group("bureauSubmission"), { ...off, featureBureauSubmission: true })).toBe(true)
  })

  it("shows the asset finance group only with featureAssetFinance on", () => {
    expect(groupEnabled(group("assetFinance"), off)).toBe(false)
    expect(groupEnabled(group("assetFinance"), { featureCrm: true, featureIms: true, featureBureauSubmission: true, featureAssetFinance: false })).toBe(false)
    expect(groupEnabled(group("assetFinance"), { ...off, featureAssetFinance: true })).toBe(true)
  })

  it("always shows an ungated group", () => {
    expect(groupEnabled(group(undefined), off)).toBe(true)
  })
})
