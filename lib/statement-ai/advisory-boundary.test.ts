/**
 * The advisory boundary (goal 2026-10-17 §1, §7): nothing the credit decision
 * runs on may reach lib/statement-ai, directly or through another module. The
 * walk follows every static and dynamic import from the decision's entry
 * points, so a helper that starts importing the module breaks this test too.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "../..")

const DECISION_ENTRY_POINTS = [
  "lib/credit-checks/run-checks.ts",
  "lib/credit-checks/recompute.ts",
  "lib/credit-checks/load-facts.ts",
  "app/api/applications/[id]/decide/route.ts",
]

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["'`]([^"'`$]+)["'`]\s*\)|require\(\s*["'`]([^"'`$]+)["'`]\s*\)/g

function resolve(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2))
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec)
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep) && /\.(ts|tsx)$/.test(candidate)) return candidate
  }
  return null
}

/** Every repo file reachable from `entry` by import, with the chain that reached it. */
function importClosure(entry: string): Map<string, string[]> {
  const start = path.join(ROOT, entry)
  const seen = new Map<string, string[]>([[start, [entry]]])
  const queue = [start]
  while (queue.length) {
    const file = queue.shift()!
    const source = readFileSync(file, "utf8")
    for (const m of source.matchAll(IMPORT)) {
      const target = resolve(file, m[1] ?? m[2] ?? m[3])
      if (!target || seen.has(target)) continue
      seen.set(target, [...seen.get(file)!, path.relative(ROOT, target)])
      queue.push(target)
    }
  }
  return seen
}

describe("statement AI stays advisory", () => {
  it.each(DECISION_ENTRY_POINTS)("%s never reaches lib/statement-ai", (entry) => {
    const closure = importClosure(entry)
    // The walk must actually walk: each entry point pulls in more than itself.
    expect(closure.size).toBeGreaterThan(3)
    const reached = [...closure.entries()].filter(([file]) => path.relative(ROOT, file).startsWith(`lib${path.sep}statement-ai${path.sep}`))
    expect(reached.map(([, chain]) => chain.join(" → "))).toEqual([])
  })
})
