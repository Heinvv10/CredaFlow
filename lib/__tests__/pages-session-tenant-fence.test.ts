import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// Regression fence: dashboard and portal pages, and the components they render,
// read with the SESSION's tenant (lib/session-tenant.ts), never the deployment
// default. getDefaultTenantId() in a page shows every signed-in principal the
// default lender's rows. Crons (app/api/cron/*) have no session and keep using
// it; they are not scanned.
//
// A static scan, not a behaviour test: the helpers' behaviour is tested in
// lib/session-tenant.test.ts and the shells' identity in
// components/app-shell/shell-identity-session-tenant.test.tsx. This only stops
// a file from reintroducing the call.

const ROOT = path.resolve(__dirname, "../..")
const SCANNED = ["app/(dashboard)", "app/(portal)", "components"]
// Where the lender identity shown must be the signed-in principal's. The
// request host is not the principal: on an unmapped host getResolvedTenantId()
// answers the default lender, so a file here that reads identity must not
// resolve its tenant from the host.
const IDENTITY_SCANNED = ["app/(dashboard)", "app/(portal)", "components/app-shell"]
const IDENTITY_IMPORT = /from "@\/lib\/config\/(identity|lender-logo)"/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return []
    return [full]
  })
}

describe("dashboard and portal pages never read with the default tenant", () => {
  it("scans a non-trivial number of files (the walk itself works)", () => {
    const files = SCANNED.flatMap((d) => sourceFiles(path.join(ROOT, d)))
    expect(files.length).toBeGreaterThan(100)
  })

  it("no source file under app/(dashboard), app/(portal) or components calls getDefaultTenantId", () => {
    const offenders = SCANNED.flatMap((d) => sourceFiles(path.join(ROOT, d)))
      .filter((f) => readFileSync(f, "utf8").includes("getDefaultTenantId"))
      .map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it("no file that reads the lender identity resolves its tenant from the request host", () => {
    const files = IDENTITY_SCANNED.flatMap((d) => sourceFiles(path.join(ROOT, d)))
    const readers = files.filter((f) => IDENTITY_IMPORT.test(readFileSync(f, "utf8")))
    // The walk found the identity readers this fence exists for.
    expect(readers.map((f) => path.relative(ROOT, f))).toEqual(expect.arrayContaining([
      "components/app-shell/PortalShell.tsx",
      "components/app-shell/AppTopbar.tsx",
      "app/(portal)/portal/payment/failure/page.tsx",
    ]))
    const offenders = readers
      .filter((f) => readFileSync(f, "utf8").includes("getResolvedTenantId"))
      .map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  // getResolvedTenantId() answers the request HOST's tenant (the default on an
  // unmapped host), not the signed-in principal's. A page may use it only to
  // refuse a mismatch: `if (<session>.tenantId !== tenantId) notFound()`. Every
  // other page reads with getStaffTenantId / getPortalTenantId. Adding a file
  // here needs that guard; the second assertion checks it is present.
  const HOST_TENANT_GUARDED = [
    "app/(dashboard)/compliance/breach-log/page.tsx",
    "app/(dashboard)/compliance/bureau-submissions/page.tsx",
    "app/(dashboard)/compliance/complaints/page.tsx",
    "app/(dashboard)/compliance/dsar/page.tsx",
    "app/(dashboard)/settings/branches/page.tsx",
    "app/(portal)/portal/agreement/[applicationId]/page.tsx",
    "app/(portal)/portal/mandate/[applicationId]/page.tsx",
  ]

  it("only the session-guarded pages under app/(dashboard) and app/(portal) use getResolvedTenantId", () => {
    const users = ["app/(dashboard)", "app/(portal)"]
      .flatMap((d) => sourceFiles(path.join(ROOT, d)))
      .filter((f) => readFileSync(f, "utf8").includes("getResolvedTenantId"))
      .map((f) => path.relative(ROOT, f))
      .sort()
    expect(users).toEqual([...HOST_TENANT_GUARDED].sort())
  })

  it.each(HOST_TENANT_GUARDED)("%s refuses a host tenant that is not the session's", (file) => {
    expect(readFileSync(path.join(ROOT, file), "utf8")).toMatch(/\.tenantId !== tenantId\) notFound\(\)/)
  })
})
