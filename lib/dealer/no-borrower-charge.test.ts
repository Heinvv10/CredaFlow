import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// Commission is never a borrower charge (SLICE5.md "NCA cost of credit
// untouched"). The modules that produce the borrower's figures, and every
// module they import transitively, must not import the dealer domain or the
// commission journals, nor read a dealerCommission* column: the borrower's
// figures cannot depend on a dealer even by accident. The real-DB proof that
// they do not is lib/dealer/cost-of-credit.integration.test.ts.
const ROOT = path.resolve(__dirname, "../..")
const COST_OF_CREDIT = [
  "lib/asset-finance/deal-structure.ts", // solveWithRate
  "lib/asset-finance/nca-structure.ts", // solveNcaDealStructure
  "lib/asset-finance/nca-evidence.ts", // assetCalculatorEvidence, createAssetPasqEvidence
  "lib/compliance/pasq.ts", // calculatePasqTotalCostOfCreditCents
  "lib/asset-finance/booking-plan.ts", // planBooking
]
const FORBIDDEN_MODULES = [/^lib\/dealer\//, /^lib\/accounting\/sources-dealer-commission/]
const FORBIDDEN_READ = /dealerCommission/

const SPECIFIER = /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm

function resolve(from: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith("@/")) base = path.join(ROOT, specifier.slice(2))
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(path.join(ROOT, from)), specifier)
  else return null // a package
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
      if (existsSync(candidate)) return path.relative(ROOT, candidate)
    }
  }
  return null
}

/** Every repository module `entry` reaches through static and dynamic imports. */
function closure(entries: string[]): Map<string, string> {
  const seen = new Map<string, string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    const source = readFileSync(path.join(ROOT, file), "utf8")
    seen.set(file, source)
    for (const match of source.matchAll(SPECIFIER)) {
      const target = resolve(file, match[1] ?? match[2] ?? match[3])
      if (target && !seen.has(target)) queue.push(target)
    }
  }
  return seen
}

describe("the borrower's cost of credit never depends on a dealer", () => {
  const modules = closure(COST_OF_CREDIT)

  it("walks a real import graph (the five modules and what they import)", () => {
    for (const entry of COST_OF_CREDIT) expect(modules.has(entry), entry).toBe(true)
    expect(modules.size).toBeGreaterThan(COST_OF_CREDIT.length)
    expect(modules.has("lib/asset-finance/schedule-records.ts")).toBe(true)
  })

  it("imports no dealer or commission module, directly or transitively", () => {
    const offenders = [...modules.keys()].filter((file) => FORBIDDEN_MODULES.some((re) => re.test(file)))
    expect(offenders).toEqual([])
  })

  it("reads no dealerCommission* column anywhere in that graph", () => {
    const offenders = [...modules].filter(([, source]) => FORBIDDEN_READ.test(source)).map(([file]) => file)
    expect(offenders).toEqual([])
  })
})
