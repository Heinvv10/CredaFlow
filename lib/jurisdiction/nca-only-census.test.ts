import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { NcaOnlyGate, NcaOnlySurfaces } from "./nca-only-registry"
import { stripComments } from "./strip-comments"

const ROOT = path.resolve(__dirname, "..", "..")
const modules = import.meta.glob<{ default: NcaOnlySurfaces }>("../registry/nca-only/*.ts", { eager: true })
const entries = Object.entries(modules).flatMap(([file, mod]) => Object.entries(mod.default).map(([surface, gate]) => ({ file, surface, gate })))

/** The file's code, comments removed: a comment that names a gate does not count as one. */
const code = (rel: string) => stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"))
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel))

const GATE_CALL = /\bawait\s+(?:ncaOnlyRefusal|ncaOnlyPage|ncaOnlyCronSkip)\(/

// Surfaces whose path says they are an NCA, NCR, FSCA, FIC or TCF matter. Anything
// matching that is not in the registry fails: a new NCA-only route must be declared,
// and declaring it means saying how a lender outside the NCA is kept out.
const NCA_PATH = /section129|ncr-return|fsca-return|reference-rate|repo-rate|debt-review|certificate-of-balance|attorney-referral|documents\/generate|nca-|\/tcf|compliance\/fic|reckless/i

function surfaces(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...surfaces(rel))
    else if (/^(route\.ts|page\.tsx)$/.test(e.name)) out.push(rel)
  }
  return out
}

/** The text of one `type === "<name>"` branch of a route that switches on a report type. */
function branch(source: string, type: string): string | null {
  const start = source.indexOf(`type === "${type}"`)
  if (start === -1) return null
  const next = source.indexOf("} else if (type ===", start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

describe("NCA-only surface census (structure, comments ignored)", () => {
  it("every registered surface exists and is gated as it says", () => {
    expect(entries.length).toBeGreaterThan(30)
    for (const { surface, gate } of entries) {
      expect(exists(surface), `${surface} exists`).toBe(true)
      const source = code(surface)
      if (gate.gate === "direct") {
        expect(GATE_CALL.test(source), `${surface} must await ncaOnlyRefusal / ncaOnlyPage / ncaOnlyCronSkip in code`).toBe(true)
      } else if (gate.gate === "branches") {
        for (const type of gate.types) {
          const text = branch(source, type)
          expect(text, `${surface} has a type === "${type}" branch`).not.toBeNull()
          expect(/\bawait\s+ncaOnlyRefusal\(/.test(text ?? ""), `${surface}: the "${type}" branch must refuse inside itself`).toBe(true)
        }
      } else {
        const via: Extract<NcaOnlyGate, { gate: "via" }> = gate
        expect(via.reason.length, `${surface} needs a reason`).toBeGreaterThan(20)
        for (const proof of via.proof) {
          expect(code(proof.file).includes(proof.contains), `${surface}: ${proof.file} must contain ${proof.contains}`).toBe(true)
        }
      }
    }
  })

  it("a comment that mentions the gate does not satisfy it", () => {
    const commentedOut = stripComments("// await ncaOnlyRefusal(\n/* await ncaOnlyPage( */ run()")
    expect(GATE_CALL.test(commentedOut)).toBe(false)
  })

  it("every NCA-looking route or page outside the asset-finance module is registered", () => {
    const registered = new Set(entries.map((e) => e.surface))
    const found = surfaces("app").filter((s) => NCA_PATH.test(s) && !s.includes("asset-finance/"))
    // The loan product settings pages carry the cap through lib/product-config, which
    // is gated (nca-gates.test.ts); they are not NCA-only surfaces themselves.
    const missing = found.filter((s) => !registered.has(s))
    expect(missing, `NCA-looking surfaces missing from lib/registry/nca-only/: ${missing.join(", ")}`).toEqual([])
  })
})

/** Resolves an import of `file` to a repo-relative source file, or null (a package). */
function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? path.posix.join(path.posix.dirname(from), spec) : null
  if (!base) return null
  for (const ext of [".ts", ".tsx", "/index.ts"]) if (exists(base + ext)) return base + ext
  return null
}

// The route wrappers that carry the module gate for the routes built on them
// (lib/asset-finance/payout-route.ts, lib/telematics/route.ts, ...). Only these
// are followed: an import of an unrelated library that happens to call the gate
// elsewhere must not count as the route being gated.
const WRAPPER_FILE = /(?:^|\/)(?:[\w-]*-)?route\.ts$/

const CALLS_GATE = /\brequireAssetFinanceEnabled\(|\bncaOnlyRefusal\(/

/** Whether the route file calls the gate, or is built on a wrapper file (followed through wrappers only) that does. */
function reachesAssetFinanceGate(file: string): boolean {
  const seen = new Set([file])
  const queue = [file]
  while (queue.length) {
    const current = queue.shift() as string
    const source = code(current)
    if (CALLS_GATE.test(source)) return true
    for (const m of source.matchAll(/from "([^"]+)"/g)) {
      const target = resolveImport(current, m[1])
      if (target && !seen.has(target) && WRAPPER_FILE.test(target)) { seen.add(target); queue.push(target) }
    }
  }
  return false
}

describe("asset finance is closed to a lender outside the NCA's jurisdiction", () => {
  const routes = [...surfaces("app/api/asset-finance"), ...surfaces("app/api/portal/asset-finance")].filter((s) => s.endsWith("route.ts"))

  it("every asset-finance API route reaches the module gate, itself or through its wrapper", () => {
    expect(routes.length).toBeGreaterThan(100)
    const ungated = routes.filter((r) => !reachesAssetFinanceGate(r))
    expect(ungated, `asset-finance routes with no module gate: ${ungated.join(", ")}`).toEqual([])
  })

  it("the gate is the single feature resolver, which forces the module off outside the NCA", () => {
    expect(code("lib/tenant.ts")).toContain("&& isNcaJurisdiction()")
    expect(code("lib/asset-finance/require-enabled.ts")).toContain("resolveFeatureFlags(config).featureAssetFinance")
  })
})
