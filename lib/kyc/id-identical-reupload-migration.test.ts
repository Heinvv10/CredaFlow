/**
 * Static proof for migration 20261015130000_identical_id_reupload_not_replacement.
 * What the rule does when it runs is proven against Postgres, beside the
 * TypeScript, by id-identical-reupload.integration.test.ts.
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineFunctionSql } from "@/lib/db-baseline.test-helpers"

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations")
const read = (dir: string) => fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8")
const MIGRATION = "20261015130000_identical_id_reupload_not_replacement"
const PREVIOUS = "20261014130000_replacement_id_pending_not_verified"

function functionIn(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf("$function$;", start) + "$function$;".length)
}

/** The body without comments or layout: what Postgres executes. */
const executable = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim()

/**
 * Re-pin only with a reason: any change to the executable body changes this,
 * and the TS mirror (pendingIdReplacement) and the parity suite must move with it.
 */
const PINNED_BODY_SHA256 = "b182eab410463aca4778bafef9a2804d7f72ac98676a8d2be3fa70c4863c81c5"

const ORDER = (alias: string) => `ORDER BY ${alias}."createdAt" DESC, ${alias}."id" COLLATE "C" DESC`

describe(`migration ${MIGRATION}`, () => {
  const current = baselineFunctionSql("subject_has_pending_id_replacement")

  it("is the newest definition of subject_has_pending_id_replacement", () => {
    expect(current).toBe(functionIn(read(MIGRATION), "subject_has_pending_id_replacement"))
  })

  it("pins the executable body", () => {
    expect(createHash("sha256").update(executable(current)).digest("hex")).toBe(PINNED_BODY_SHA256)
  })

  it("anchors on the newest verified copy, in the order 20261014130000 chose copies", () => {
    const previous = functionIn(read(PREVIOUS), "subject_has_pending_id_replacement")
    expect(previous).toContain(ORDER("candidate"))
    expect(current).toContain(ORDER("verified_copy"))
    expect(current).toContain(`verified_copy."verified" = true`)
    expect(current).toContain(`verified_copy."deletedAt" IS NULL`)
    // One LIMIT 1, on the anchor: every later candidate is checked, not only the newest.
    expect(executable(current).match(/LIMIT 1/g)).toHaveLength(1)
  })

  it("counts a candidate created after the anchor in that same order", () => {
    expect(executable(current)).toContain(executable(`
      candidate."createdAt" > current_copy."createdAt"
      OR ( candidate."createdAt" = current_copy."createdAt"
        AND candidate."id" COLLATE "C" > current_copy."id" COLLATE "C" )`))
  })

  it("counts only unverified, unrefused, non-deleted ID copies of this client", () => {
    for (const condition of [
      `candidate."tenantId" = p_tenant_id`, `candidate."clientId" = p_client_id`,
      `candidate."docType" = 'ID_COPY'`, `candidate."deletedAt" IS NULL`, `candidate."verified" = false`,
      `candidate."verificationRejectedAt" IS NULL`, `candidate."verificationRejectedById" IS NULL`,
    ]) expect(current).toContain(condition)
  })

  it("exempts only a well-formed digest equal to the anchor's, failing closed on NULL", () => {
    expect(executable(current)).toContain(executable(`
      WHERE NOT coalesce(
        candidate."contentSha256" ~ '^[a-f0-9]{64}$'
        AND candidate."contentSha256" = current_copy."contentSha256",
        false )`))
  })

  it("changes no other function and writes no data", () => {
    const sql = read(MIGRATION)
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/m)
  })
})
