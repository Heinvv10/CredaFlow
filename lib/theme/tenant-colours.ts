import { checkSurfaces, type Row, type Tokens } from "./contrast"
import { PALETTE_SURFACES } from "./palette-tokens"

/** TenantConfig colour column → the variable TenantThemeProvider publishes it as. */
export const TENANT_COLOUR_VARS = {
  primaryColor: "--cf-tenant-primary",
  secondaryColor: "--cf-tenant-secondary",
  darkColor: "--cf-tenant-dark",
} as const

export type TenantColourField = keyof typeof TENANT_COLOUR_VARS
export type TenantColours = Record<TenantColourField, string>

const FIELDS = Object.keys(TENANT_COLOUR_VARS) as TenantColourField[]
const HEX = /^#[0-9a-f]{6}$/i

/** The palette's own defaults (app/globals.css :root). */
export const DEFAULT_TENANT_COLOURS: TenantColours = {
  primaryColor: PALETTE_SURFACES.dark["--cf-tenant-primary"],
  secondaryColor: PALETTE_SURFACES.dark["--cf-tenant-secondary"],
  darkColor: PALETTE_SURFACES.dark["--cf-tenant-dark"],
}

const key = (r: Row) => `${r.surface} ${r.fg} ${r.bg}`
const overrides = (c: TenantColours): Tokens =>
  Object.fromEntries(FIELDS.map((f) => [TENANT_COLOUR_VARS[f], c[f]]))

/** The tenant variables a token's value reaches through var(). */
function tenantVarsOf(token: string, tokens: Tokens, seen = new Set<string>()): Set<string> {
  const out = new Set<string>()
  if (seen.has(token) || tokens[token] === undefined) return out
  seen.add(token)
  for (const [, name] of tokens[token].matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
    if (Object.values(TENANT_COLOUR_VARS).includes(name as never)) out.add(name)
    for (const v of tenantVarsOf(name, tokens, seen)) out.add(v)
  }
  return out
}

/**
 * Why each colour cannot be saved, by field; `{}` when the set is acceptable.
 *
 * A value must be `#rrggbb` (TenantThemeProvider drops anything else), and
 * with the three colours applied every text/surface pair the palette check
 * measures must clear WCAG AA (4.5:1) in light mode, dark mode and on the
 * website. A failing pair is blamed on the field whose reset to the default
 * alone makes it pass; when none does, on every tenant colour it involves.
 */
export function tenantColourErrors(colours: TenantColours): Partial<Record<TenantColourField, string>> {
  const errors: Partial<Record<TenantColourField, string>> = {}
  for (const f of FIELDS) {
    if (typeof colours[f] !== "string" || !HEX.test(colours[f])) errors[f] = "must be a #rrggbb hex colour"
  }
  if (Object.keys(errors).length > 0) return errors

  const failing = checkSurfaces(PALETTE_SURFACES, overrides(colours)).filter((r) => !r.pass)
  if (failing.length === 0) return errors

  const passesWithDefault = Object.fromEntries(
    FIELDS.map((f) => {
      const rows = checkSurfaces(PALETTE_SURFACES, overrides({ ...colours, [f]: DEFAULT_TENANT_COLOURS[f] }))
      return [f, new Set(rows.filter((r) => r.pass).map(key))]
    }),
  ) as Record<TenantColourField, Set<string>>

  for (const row of failing) {
    const tokens = PALETTE_SURFACES[row.surface as keyof typeof PALETTE_SURFACES]
    const involved = new Set([...tenantVarsOf(row.fg, tokens), ...tenantVarsOf(row.bg, tokens), ...tenantVarsOf("--cf-bg", tokens)])
    const candidates = FIELDS.filter((f) => involved.has(TENANT_COLOUR_VARS[f]))
    const blamed = candidates.filter((f) => passesWithDefault[f].has(key(row)))
    for (const f of blamed.length > 0 ? blamed : candidates) {
      errors[f] ??= `${row.surface}: ${row.fg} on ${row.bg} is ${row.ratio.toFixed(2)}:1, below 4.5:1`
    }
  }
  return errors
}
