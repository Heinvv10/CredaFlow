/**
 * WCAG contrast of the CredaFlow palette, read from app/globals.css.
 *
 * Resolves the theme tokens for the three surfaces — the staff/portal app in
 * dark mode (`:root`) and light mode (`html[data-theme="light"]`), and the
 * always-dark public website (`.cf-site-surface`) — with the tenant colours at
 * their defaults, then measures every text token against every surface it is
 * drawn on. `var()` (with fallbacks), `color-mix(in srgb, …)`, hex and
 * rgb()/rgba() are understood; a translucent surface is composited over the
 * page background first.
 *
 *   npx tsx scripts/palette-contrast.ts      # prints the table, exits 1 on a failure
 *
 * scripts/__tests__/palette-contrast.test.ts runs the same check in the gate.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

type RGBA = [number, number, number, number]
type Tokens = Record<string, string>

export const AA_TEXT = 4.5

function block(css: string, selector: string): Tokens {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no "${selector} {" block in globals.css`)
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start))
  const out: Tokens = {}
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, " ").trim()
  return out
}

export function surfaces(css: string): Record<"dark" | "light" | "site", Tokens> {
  const root = block(css, ":root")
  return {
    dark: root,
    light: { ...root, ...block(css, 'html[data-theme="light"]') },
    site: { ...root, ...block(css, ".cf-site-surface") },
  }
}

function splitArgs(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ""
  for (const ch of s) {
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = "" } else cur += ch
  }
  out.push(cur.trim())
  return out
}

export function resolve(value: string, tokens: Tokens, seen = new Set<string>()): RGBA {
  const v = value.trim()
  const fn = /^([a-z-]+)\(([\s\S]*)\)$/.exec(v)
  if (fn?.[1] === "var") {
    const [name, fallback] = splitArgs(fn[2])
    if (tokens[name] !== undefined && !seen.has(name)) return resolve(tokens[name], tokens, new Set(seen).add(name))
    if (fallback !== undefined) return resolve(fallback, tokens, seen)
    throw new Error(`unresolved ${name}`)
  }
  if (fn?.[1] === "color-mix") {
    const [space, a, b] = splitArgs(fn[2])
    if (space !== "in srgb") throw new Error(`color-mix space ${space} not supported`)
    const part = (s: string) => {
      const m = /^(.*?)\s+([\d.]+)%$/.exec(s)
      return m ? { c: resolve(m[1], tokens, seen), p: Number(m[2]) / 100 } : { c: resolve(s, tokens, seen), p: undefined }
    }
    const pa = part(a), pb = part(b)
    const wa = pa.p ?? (pb.p !== undefined ? 1 - pb.p : 0.5)
    return [0, 1, 2, 3].map((i) => pa.c[i] * wa + pb.c[i] * (1 - wa)) as RGBA
  }
  if (fn?.[1] === "rgb" || fn?.[1] === "rgba") {
    const [r, g, b, a = "1"] = splitArgs(fn[2])
    return [Number(r), Number(g), Number(b), Number(a)]
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1]
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as RGBA
  }
  throw new Error(`cannot resolve colour "${v}"`)
}

function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3]
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1) as RGBA
}

function luminance([r, g, b]: RGBA): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(fg: RGBA, bg: RGBA): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

const TEXT = ["--cf-text", "--cf-text-secondary", "--cf-text-muted", "--cf-brand", "--cf-brand-alt", "--cf-brand-soft",
  "--cf-success", "--cf-warning", "--cf-danger", "--cf-info"]
const SURFACES = ["--cf-bg", "--cf-bg-panel", "--cf-bg-raised", "--cf-bg-subtle", "--cf-surface-soft", "--cf-surface-hover", "--cf-surface-strong"]
const ON = [["--cf-on-brand", "--cf-brand"], ["--cf-on-brand", "--cf-brand-alt"], ["--cf-on-success", "--cf-success"]]

export type Row = { surface: string; fg: string; bg: string; ratio: number; pass: boolean }

/** `tenant` overrides the --cf-tenant-* defaults, as TenantThemeProvider does. */
export function check(css: string, tenant: Tokens = {}): Row[] {
  const rows: Row[] = []
  for (const [surface, base] of Object.entries(surfaces(css))) {
    const tokens = { ...base, ...tenant }
    const page = resolve("var(--cf-bg)", tokens)
    const pairs: [string, string][] = [
      ...TEXT.flatMap((fg) => SURFACES.filter((bg) => tokens[bg] !== undefined).map((bg) => [fg, bg] as [string, string])),
      ...(ON as [string, string][]).filter(([fg]) => tokens[fg] !== undefined),
    ]
    for (const [fg, bg] of pairs) {
      if (tokens[fg] === undefined) continue
      const back = over(resolve(`var(${bg})`, tokens), page)
      const ratio = contrast(over(resolve(`var(${fg})`, tokens), back), back)
      rows.push({ surface, fg, bg, ratio, pass: ratio >= AA_TEXT })
    }
  }
  return rows
}

if (process.argv[1]?.endsWith("palette-contrast.ts")) {
  const rows = check(readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8"))
  for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.surface.padEnd(5)} ${r.fg.padEnd(22)} on ${r.bg.padEnd(20)} ${r.ratio.toFixed(2)}:1`)
  const failed = rows.filter((r) => !r.pass).length
  console.log(`${rows.length} pairs, ${failed} below ${AA_TEXT}:1`)
  process.exit(failed ? 1 : 0)
}
