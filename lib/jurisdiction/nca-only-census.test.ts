import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { NcaOnlyGate, NcaOnlySurfaces } from "./nca-only-registry"

const ROOT = path.resolve(__dirname, "..", "..")
const modules = import.meta.glob<{ default: NcaOnlySurfaces }>("../registry/nca-only/*.ts", { eager: true })
const entries = Object.entries(modules).flatMap(([file, mod]) => Object.entries(mod.default).map(([surface, gate]) => ({ file, surface, gate })))
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const DIRECT = /ncaOnlyRefusal\(|isNcaJurisdiction\(\)/

// Surfaces whose path says they are an NCA/NCR/FSCA matter. Anything matching
// that is not in the registry fails: a new NCA-only route must be declared, and
// declaring it means saying how a lender outside the NCA is kept out.
const NCA_PATH = /section129|ncr-return|fsca-return|reference-rate|repo-rate|debt-review|certificate-of-balance|attorney-referral|documents\/generate|nca-/i

function surfaces(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...surfaces(rel))
    else if (/^(route\.ts|page\.tsx)$/.test(e.name)) out.push(rel)
  }
  return out
}

describe("NCA-only surface census", () => {
  it("every registered surface exists and is gated as it says", () => {
    expect(entries.length).toBeGreaterThan(10)
    for (const { surface, gate } of entries) {
      expect(fs.existsSync(path.join(ROOT, surface)), `${surface} exists`).toBe(true)
      if (gate.gate === "direct") {
        expect(DIRECT.test(read(surface)), `${surface} must call ncaOnlyRefusal() or isNcaJurisdiction()`).toBe(true)
      } else {
        const via: Extract<NcaOnlyGate, { gate: "via" }> = gate
        expect(via.reason.length, `${surface} needs a reason`).toBeGreaterThan(20)
        for (const proof of via.proof) {
          expect(read(proof.file).includes(proof.contains), `${surface}: ${proof.file} must contain ${proof.contains}`).toBe(true)
        }
      }
    }
  })

  it("every NCA-looking route or page outside the asset-finance module is registered", () => {
    const registered = new Set(entries.map((e) => e.surface))
    const found = surfaces("app").filter((s) => NCA_PATH.test(s) && !s.includes("asset-finance/"))
    // The loan product settings pages carry the cap through lib/product-config, which
    // is gated (nca-gates.test.ts); they are not NCA-only surfaces themselves.
    const missing = found.filter((s) => !registered.has(s))
    expect(missing, `NCA-looking surfaces missing from lib/registry/nca-only/: ${missing.join(", ")}`).toEqual([])
  })

  // The module's routes sit behind featureAssetFinance (resolveFeatureFlags), which an
  // LS lender cannot have. Not every asset-finance route calls requireAssetFinanceEnabled
  // today; a per-route sweep is a follow-up (see the PR).
  it("asset finance is closed to a lender outside the NCA by its single feature resolver", () => {
    expect(read("lib/tenant.ts")).toContain("&& isNcaJurisdiction()")
    expect(read("lib/asset-finance/require-enabled.ts")).toContain("resolveFeatureFlags")
  })
})
