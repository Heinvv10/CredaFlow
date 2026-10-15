/**
 * Static proof for migration 20261015090000_identical_id_reupload_not_replacement.
 * What the rule does when it runs is proven against Postgres, beside the
 * TypeScript, by id-identical-reupload.integration.test.ts.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineFunctionSql } from "@/lib/db-baseline.test-helpers"

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations")
const read = (dir: string) => fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8")
const MIGRATION = "20261015090000_identical_id_reupload_not_replacement"
const PREVIOUS = "20261014130000_replacement_id_pending_not_verified"

function functionIn(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf("$function$;", start) + "$function$;".length)
}

const RULE = /\n\s*-- BEGIN identical-reupload rule[\s\S]*?-- END identical-reupload rule/
const COLUMNS = `SELECT candidate."verified", candidate."contentSha256"`

describe(`migration ${MIGRATION}`, () => {
  const previous = functionIn(read(PREVIOUS), "subject_has_pending_id_replacement")
  const current = baselineFunctionSql("subject_has_pending_id_replacement")

  it("is the newest definition of subject_has_pending_id_replacement", () => {
    expect(current).toBe(functionIn(read(MIGRATION), "subject_has_pending_id_replacement"))
  })

  it("is the previous body plus the digest column and one delimited condition, nothing else", () => {
    expect(RULE.test(current)).toBe(true)
    expect(current).toContain(COLUMNS)
    const withoutRule = current.replace(RULE, "").replace(COLUMNS, `SELECT candidate."verified"`)
    expect(withoutRule).toBe(previous)
  })

  it("matches only a well-formed digest equal to the newest verified copy's, failing closed on NULL", () => {
    const rule = current.match(RULE)?.[0] ?? ""
    expect(rule).toContain(`AND NOT coalesce(`)
    expect(rule).toContain(`newest."contentSha256" ~ '^[a-f0-9]{64}$'`)
    expect(rule).toContain(`AND newest."contentSha256" = (`)
    expect(rule).toContain(`current_copy."verified" = true`)
    expect(rule).toContain(`current_copy."deletedAt" IS NULL`)
    expect(rule).toContain(`ORDER BY current_copy."createdAt" DESC, current_copy."id" COLLATE "C" DESC`)
    expect(rule).toMatch(/LIMIT 1\n\s*\),\n\s*false\n\s*\)/)
  })

  it("changes no other function and writes no data", () => {
    const sql = read(MIGRATION)
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/m)
  })
})
