import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { staffNavigation } from "../navigation"
import { ROLE_HIERARCHY, type UserRole } from "../permissions"

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
import { PERMISSIONS } from "../auth-guards"

// Fair Score audit (2026-10-16): the sidebar offered pages a role could not
// open (Reports, Disbursements, Complaints, DSAR, Claims, Agent Hub...), and
// clicking one dropped the user on the public site. Each item's minRole must be
// exactly the role gate of the page it opens.
//
// A static check, read from the page source (a page's gate runs on a server
// render this suite cannot do); app/(dashboard)/**/page.tsx gates through
// requireMinRole, so that is what it reads.
const DASHBOARD = join(__dirname, "..", "..", "app", "(dashboard)")
// Gated by a per-user flag as well as a role, which a nav minRole cannot express.
const NOT_ROLE_GATED = new Set(["/inbox"])

function pageGate(href: string): UserRole {
  const segments = href.split("/").filter(Boolean)
  const files = [join(DASHBOARD, ...segments, "page.tsx")]
  for (let i = segments.length; i > 0; i--) files.push(join(DASHBOARD, ...segments.slice(0, i), "layout.tsx"))
  const source = files.filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n")
  const gates: UserRole[] = [...source.matchAll(/requireMinRole\(\s*(?:"([A-Z_]+)"|PERMISSIONS\.(\w+))\s*\)/g)].map(
    ([, role, permission]) => (role ?? PERMISSIONS[permission as keyof typeof PERMISSIONS]) as UserRole,
  )
  if (/requireAssetFinanceStaffPage\(\)/.test(source)) gates.push("READONLY")
  // lib/dealer/staff-page.ts: the asset-finance gate, then manage_dealers (asserted below).
  if (/requireDealerStaffPage\(\)/.test(source)) gates.push(PERMISSIONS.manage_dealers as UserRole)
  // The strictest gate on the path is the one that bites.
  return gates.reduce<UserRole>((max, g) => (ROLE_HIERARCHY.indexOf(g) > ROLE_HIERARCHY.indexOf(max) ? g : max), "READONLY")
}

describe("staff navigation shows only what the role can open", () => {
  const items = staffNavigation.flatMap((g) => g.items).filter((i) => !i.external && !NOT_ROLE_GATED.has(i.href))

  it.each(items.map((i) => [i.href, i] as const))("%s: the sidebar gate equals the page's gate", (href, item) => {
    expect(existsSync(join(DASHBOARD, ...href.split("/").filter(Boolean), "page.tsx"))).toBe(true)
    expect(item.minRole ?? "READONLY").toBe(pageGate(href))
  })

  it("requireDealerStaffPage gates on manage_dealers", () => {
    expect(readFileSync(join(__dirname, "..", "dealer", "staff-page.ts"), "utf8")).toMatch(/if \(!canDo\(user\.role, "manage_dealers"\)\) redirect\(/)
  })
})
