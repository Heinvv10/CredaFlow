import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AA_TEXT, check, contrast, resolve, surfaces } from "../palette-contrast"

const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8")

// The inherited bronze/gold brand palette. CredaFlow's default palette is
// neutral; none of these may come back as a hardcoded colour.
const OLD_BRAND = ["a56c24", "c8893a", "c8973e", "c8963e", "b9853a", "d0a257", "d0a35f", "e2c88b", "955f24", "754819",
  "e0b775", "e0b371", "e0b370", "e1b56d", "aa6b29", "8a5a1e", "6b4a1d", "e5c896", "231f20", "0d0b09", "171412"]
const OLD_RGB = ["165, ?108, ?36", "200, ?137, ?58", "200, ?15[01], ?62", "185, ?133, ?58", "215, ?183, ?122", "208, ?163, ?95",
  "165 / 255, 108 / 255, 36 / 255", "35 / 255, 31 / 255, 32 / 255"]

describe("CredaFlow palette", () => {
  it("every text token clears WCAG AA on every surface, light and dark", () => {
    const rows = check(css)
    expect(rows.length).toBeGreaterThan(150)
    expect(rows.filter((r) => !r.pass).map((r) => `${r.surface} ${r.fg} on ${r.bg} ${r.ratio.toFixed(2)}`)).toEqual([])
  })

  // Light-mode brand and the dark page background are the tenant's own
  // colours, used as given; nothing validates them on write yet. The demo
  // tenant at least must pass everywhere.
  it("the seeded demo tenant's colours clear WCAG AA on every surface", () => {
    const seed = readFileSync(join(process.cwd(), "prisma", "seed.ts"), "utf8")
    const colour = (k: string) => new RegExp(`${k}: "(#[0-9A-Fa-f]{6})"`).exec(seed)![1]
    const rows = check(css, {
      "--cf-tenant-primary": colour("primaryColor"),
      "--cf-tenant-secondary": colour("secondaryColor"),
      "--cf-tenant-dark": colour("darkColor"),
    })
    expect(rows.filter((r) => !r.pass).map((r) => `${r.surface} ${r.fg} on ${r.bg} ${r.ratio.toFixed(2)}`)).toEqual([])
  })

  it("brand colours come from the tenant variables", () => {
    for (const mode of ["dark", "light", "site"] as const) {
      const t = surfaces(css)[mode]
      const before = resolve("var(--cf-brand)", t)
      const after = resolve("var(--cf-brand)", { ...t, "--cf-tenant-primary": "#ff0000" })
      expect(after, mode).not.toEqual(before)
      expect(resolve("var(--cf-brand-alt)", { ...t, "--cf-tenant-secondary": "#ff0000" }), mode)
        .not.toEqual(resolve("var(--cf-brand-alt)", t))
    }
  })

  it("on dark surfaces the brand stays readable whatever primary a tenant picks", () => {
    for (const mode of ["dark", "site"] as const) {
      for (const primary of ["#000000", "#ffffff", "#000080", "#ff0000", "#ffff00", "#4f46e5"]) {
        const t = { ...surfaces(css)[mode], "--cf-tenant-primary": primary, "--cf-tenant-secondary": primary }
        for (const bg of ["--cf-bg", "--cf-bg-panel", "--cf-bg-raised", "--cf-bg-subtle"]) {
          for (const fg of ["--cf-brand", "--cf-brand-alt"]) {
            const ratio = contrast(resolve(`var(${fg})`, t), resolve(`var(${bg})`, t))
            expect(ratio, `${mode} ${fg} (${primary}) on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT)
          }
        }
      }
    }
  })

  it("no bronze/gold colour is hardcoded anywhere", () => {
    const pattern = `#(${OLD_BRAND.join("|")})([0-9a-f]{2})?\\b|\\b(${OLD_RGB.join("|")})\\b`
    let hits: string[] = []
    try {
      hits = execFileSync("git", ["grep", "--untracked", "-liP", pattern, "--", "app", "components", "lib", "prisma/schema.prisma", "prisma/seed*.ts", "scripts", ":!scripts/__tests__/palette-contrast.test.ts"], { encoding: "utf8" })
        .split("\n").filter(Boolean)
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e
    }
    expect(hits).toEqual([])
  })
})
