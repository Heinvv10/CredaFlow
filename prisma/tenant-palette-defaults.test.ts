import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// The TenantConfig colour defaults are CredaFlow's neutral palette in three
// places that must agree: the schema, the migration that set them after the
// baseline, and the --cf-tenant-* fallbacks in app/globals.css (what a page
// shows with no TenantConfig colours). The migration may only change column
// defaults: it rewrites no rows and adds no enforcement object.

const MIGRATION = "20261009120000_neutral_tenant_palette"
const root = path.join(__dirname, "..")
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8")

const COLUMNS = { primaryColor: "--cf-tenant-primary", secondaryColor: "--cf-tenant-secondary", darkColor: "--cf-tenant-dark" } as const

function schemaDefaults(): Record<string, string> {
  const model = /model TenantConfig \{([\s\S]*?)\n\}/.exec(read("prisma", "schema.prisma"))![1]
  return Object.fromEntries(Object.keys(COLUMNS).map((c) => [c, new RegExp(`\\b${c}\\s+String\\s+@default\\("(#[0-9A-Fa-f]{6})"\\)`).exec(model)![1]]))
}

function migrationStatements(): string[] {
  return read("prisma", "migrations", MIGRATION, "migration.sql")
    .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")
    .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)
}

describe("TenantConfig palette defaults", () => {
  it("the migration only sets the three colour defaults", () => {
    const set = migrationStatements().map((s) => {
      const m = /^ALTER TABLE "TenantConfig" ALTER COLUMN "(\w+)" SET DEFAULT '(#[0-9A-Fa-f]{6})'$/.exec(s)
      expect(m, `not a colour-default statement: ${s}`).not.toBeNull()
      return [m![1], m![2]]
    })
    expect(Object.fromEntries(set)).toEqual(schemaDefaults())
  })

  it("the schema defaults are the globals.css fallbacks, and are not the inherited palette", () => {
    const rootBlock = /:root \{([\s\S]*?)\n\}/.exec(read("app", "globals.css"))![1]
    for (const [column, token] of Object.entries(COLUMNS)) {
      const css = new RegExp(`${token}: (#[0-9a-f]{6});`).exec(rootBlock)![1]
      expect(schemaDefaults()[column].toLowerCase(), column).toBe(css)
    }
    expect(Object.values(schemaDefaults()).map((v) => v.toLowerCase())).not.toContain("#a56c24")
  })
})
