import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// Regression fence: dashboard and portal pages read with the SESSION's tenant
// (lib/session-tenant.ts), never the deployment default. getDefaultTenantId()
// in a page shows every signed-in principal the default lender's rows. Crons
// (app/api/cron/*) have no session and keep using it; they are not scanned.
//
// A static scan, not a behaviour test: the helpers' behaviour is tested in
// lib/session-tenant.test.ts. This only stops a page from reintroducing the call.

const ROOT = path.resolve(__dirname, "../..")
const SCANNED = ["app/(dashboard)", "app/(portal)"]

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

  it("no source file under app/(dashboard) or app/(portal) calls getDefaultTenantId", () => {
    const offenders = SCANNED.flatMap((d) => sourceFiles(path.join(ROOT, d)))
      .filter((f) => readFileSync(f, "utf8").includes("getDefaultTenantId"))
      .map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })
})
