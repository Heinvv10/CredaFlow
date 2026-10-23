/**
 * The repository modules a set of entry files reaches through static and
 * dynamic imports (packages excluded), for the telematics boundary tests.
 * Same resolution as lib/dealer/no-borrower-charge.test.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export const ROOT = path.resolve(__dirname, "../../..")
const SPECIFIER = /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm

function resolve(from: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith("@/")) base = path.join(ROOT, specifier.slice(2))
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(path.join(ROOT, from)), specifier)
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if ((candidate.endsWith(".ts") || candidate.endsWith(".tsx")) && existsSync(candidate)) return path.relative(ROOT, candidate)
  }
  return null
}

/** Each module's direct repository imports. */
export function importsOf(file: string): string[] {
  const source = readFileSync(path.join(ROOT, file), "utf8")
  return [...source.matchAll(SPECIFIER)].flatMap((m) => resolve(file, m[1] ?? m[2] ?? m[3]) ?? [])
}

export function closure(entries: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const target of importsOf(file)) if (!seen.has(target)) queue.push(target)
  }
  return seen
}

/** Every .ts/.tsx file under `dir` (relative to the repository), tests and fixtures excluded unless asked. */
export function sourceFiles(dir: string, opts: { tests?: boolean } = {}): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(ROOT, rel))) {
      if (name === "node_modules" || name.startsWith(".")) continue
      const child = path.join(rel, name)
      if (statSync(path.join(ROOT, child)).isDirectory()) walk(child)
      else if (/\.tsx?$/.test(name) && (opts.tests || !/\.test\.tsx?$|integration-fixture\.ts$|__fixtures__|__tests__/.test(child))) out.push(child)
    }
  }
  walk(dir)
  return out
}
