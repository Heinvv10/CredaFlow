/**
 * Every `var(--cf-…)` without a fallback must name a token that a stylesheet
 * defines. An undefined custom property makes the whole declaration invalid at
 * computed-value time, so the element silently loses its colour or border.
 *
 *   npx tsx scripts/css-vars.ts      # lists undefined uses, exits 1 if any
 *
 * scripts/__tests__/css-vars.test.ts runs the same check in the gate.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

/** Stylesheets that define `--cf-*` tokens. */
export const TOKEN_SHEETS = ["app/globals.css", "app/(quote)/quickquote-theme.css"]

const SOURCE_DIRS = ["app", "components", "lib"]
const SOURCE_EXT = /\.(tsx?|css)$/
const SKIP_DIRS = new Set(["node_modules", ".next", "__fixtures__"])

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "")

export function definedTokens(css: string): Set<string> {
  return new Set([...stripComments(css).matchAll(/(--cf-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
}

/** `var(--cf-x)` uses without a fallback; `var(--cf-x, …)` is skipped. */
export function usedTokens(source: string): string[] {
  return [...source.matchAll(/var\(\s*(--cf-[a-z0-9-]+)\s*\)/g)].map((m) => m[1])
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (SOURCE_EXT.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield p
  }
}

/** Selector lines a rule's prelude repeats — dead weight that hides real edits. */
export function duplicateSelectorLines(css: string): string[] {
  const out: string[] = []
  for (const m of stripComments(css).matchAll(/(?:^|[{}])([^{}]+)\{/g)) {
    let seen = new Set<string>()
    for (const line of m[1].split("\n").map((l) => l.trim().replace(/,$/, "")).filter(Boolean)) {
      // `:is(` opens and `)` closes a group; items only repeat within one.
      if (line.endsWith("(") || line.startsWith(")")) {
        seen = new Set()
        continue
      }
      if (seen.has(line)) out.push(line)
      seen.add(line)
    }
  }
  return out
}

/** `file: --cf-token` for every use of a token no stylesheet defines. */
export function undefinedUses(root: string, sheets: string[] = TOKEN_SHEETS.map((s) => readFileSync(join(root, s), "utf8"))): string[] {
  const defined = new Set(sheets.flatMap((css) => [...definedTokens(css)]))
  const out: string[] = []
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(root, dir))) {
      for (const token of new Set(usedTokens(readFileSync(file, "utf8")))) {
        if (!defined.has(token)) out.push(`${relative(root, file)}: ${token}`)
      }
    }
  }
  return out.sort()
}

if (process.argv[1]?.endsWith("css-vars.ts")) {
  const bad = undefinedUses(process.cwd())
  for (const line of bad) console.error(line)
  process.exit(bad.length ? 1 : 0)
}
