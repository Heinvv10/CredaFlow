import { describe, expect, it } from "vitest"
import { buildPortalNavigation, staffNavigation } from "../navigation"

describe("authenticated navigation", () => {
  it("keeps staff navigation hrefs unique", () => {
    const hrefs = staffNavigation.flatMap(group => group.items.map(item => item.href))
    expect(new Set(hrefs).size).toBe(hrefs.length)
    expect(hrefs).toContain("/dashboard")
    expect(hrefs).toContain("/applications")
    expect(hrefs).toContain("/collections")
    expect(hrefs).toContain("/reports")
  })

  it("keeps portal navigation hrefs unique and client scoped", () => {
    const hrefs = buildPortalNavigation("+27110000000").map(item => item.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    expect(hrefs.every(href => href.startsWith("/portal") || href.startsWith("https://"))).toBe(true)
    expect(hrefs).toContain("/portal")
    expect(hrefs).toContain("/portal/documents")
  })

  it("offers the Support link only when the lender has a WhatsApp number", () => {
    const withNumber = buildPortalNavigation("+27110000000").find(item => item.label === "Support")
    expect(withNumber?.href).toMatch(/^https:\/\/wa\.me\/27110000000\?/)
    expect(buildPortalNavigation(null).some(item => item.label === "Support")).toBe(false)
  })

  // The Users nav item must stay hidden from roles the backing API rejects
  // (GET /api/settings/users requires BRANCH_MANAGER) — otherwise a lower
  // role sees a link that 403s. See app/api/settings/users/route.ts.
  it("gates the Users item at BRANCH_MANAGER to match its backing API", () => {
    const usersItem = staffNavigation.flatMap(group => group.items).find(item => item.href === "/settings/users")
    expect(usersItem?.minRole).toBe("BRANCH_MANAGER")
  })

  // The page requires ADMIN (app/(dashboard)/settings/security-policy/page.tsx).
  it("lists Security & KYC policy at ADMIN, matching its page", () => {
    const item = staffNavigation.flatMap(group => group.items).find(i => i.href === "/settings/security-policy")
    expect(item?.label).toBe("Security & KYC policy")
    expect(item?.minRole).toBe("ADMIN")
  })

  // /settings/audit-log (all state-changing actions) and /settings/login-log
  // (sign-in events only) are distinct datasets that were previously
  // collapsed into one "Activity Log" item pointing only at login-log,
  // leaving the audit trail unreachable from the sidebar.
  it("keeps the audit trail and login activity items distinct and correctly gated", () => {
    const items = staffNavigation.flatMap(group => group.items)
    const auditTrail = items.find(item => item.href === "/settings/audit-log")
    const loginActivity = items.find(item => item.href === "/settings/login-log")

    expect(auditTrail).toBeDefined()
    expect(loginActivity).toBeDefined()
    expect(auditTrail?.label).not.toBe(loginActivity?.label)

    // Both backing pages call requireMinRole("LOAN_ADMIN") — see
    // app/(dashboard)/settings/audit-log/page.tsx and .../login-log/page.tsx.
    expect(auditTrail?.minRole).toBe("LOAN_ADMIN")
    expect(loginActivity?.minRole).toBe("LOAN_ADMIN")
  })

  // TOTP 2FA enrolment is on by default for every staff member (a per-lender
  // setting, CLAUDE.md), and the
  // backing page app/(dashboard)/settings/security/page.tsx only requires an
  // authenticated session (no requireMinRole) — so the nav item must be reachable
  // by all roles. Previously the page was orphaned (no link anywhere). (ADM-02)
  it("exposes the 2FA enrolment page to all staff roles (no minRole gate)", () => {
    const securityItem = staffNavigation.flatMap(group => group.items).find(item => item.href === "/settings/security")
    expect(securityItem).toBeDefined()
    expect(securityItem?.minRole).toBeUndefined()
  })
})

describe("compliance navigation is not gated on the insurance module", () => {
  const complianceHrefs = [
    "/compliance",
    "/compliance/ncr-return",
    "/compliance/complaints",
    "/compliance/dsar",
  ]

  const groupFor = (href: string) =>
    staffNavigation.find(g => g.items.some(i => i.href === href))

  it("carries no feature flag on the group holding NCA and POPIA duties", () => {
    // These are the statutory duties of a registered credit provider. They were
    // bundled into the `ims` (insurance) group, so switching the insurance
    // module off hid them and made /compliance redirect to /dashboard. The
    // matching layout gate was removed in app/(dashboard)/compliance/layout.tsx
    // — this pins the nav half so the two cannot drift back apart.
    for (const href of complianceHrefs) {
      const group = groupFor(href)
      expect(group, `no nav group contains ${href}`).toBeDefined()
      expect(group?.feature, `${href} must not be feature-gated`).toBeUndefined()
    }
  })

  it("keeps insurance items on the ims-gated group", () => {
    // The un-gating must not have leaked the other way: insurance surfaces
    // still belong behind the module switch.
    for (const href of ["/insurance", "/insurance/claims"]) {
      expect(groupFor(href)?.feature).toBe("ims")
    }
  })

  it("does not put compliance and insurance in the same group", () => {
    expect(groupFor("/compliance")).not.toBe(groupFor("/insurance"))
  })
})

describe("asset finance navigation", () => {
  const assetFinanceHrefs = [
    "/asset-finance/entities",
    "/asset-finance/deals",
    "/asset-finance/assets",
    "/asset-finance/suppliers",
    "/asset-finance/dealers",
    "/asset-finance/reference-rates",
  ]

  it("puts every asset finance page in one group behind the assetFinance flag", () => {
    const groups = new Set(assetFinanceHrefs.map((href) => staffNavigation.find(g => g.items.some(i => i.href === href))))
    expect(groups.size).toBe(1)
    const [group] = [...groups]
    expect(group?.label).toBe("Asset Finance")
    expect(group?.feature).toBe("assetFinance")
    expect(group?.items.map(i => i.href)).toEqual(assetFinanceHrefs)
  })
})

describe("portal business navigation", () => {
  it("offers the Business page only to a client who may act for an entity", () => {
    expect(buildPortalNavigation(null).some(item => item.href === "/portal/business")).toBe(false)
    expect(buildPortalNavigation(null, { business: true }).some(item => item.href === "/portal/business")).toBe(true)
  })
})
