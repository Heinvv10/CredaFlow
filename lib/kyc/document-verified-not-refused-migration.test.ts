/**
 * Static proof for migration 20261016120000_client_document_verified_not_refused.
 * What the CHECK does when it runs is proven against Postgres by
 * document-verified-not-refused.integration.test.ts.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineConstraintSql } from "@/lib/db-baseline.test-helpers"

const MIGRATION = "20261016120000_client_document_verified_not_refused"
const sql = fs.readFileSync(
  path.join(__dirname, "..", "..", "prisma", "migrations", MIGRATION, "migration.sql"),
  "utf8",
)
const code = sql.replace(/--[^\n]*/g, "")

describe(`migration ${MIGRATION}`, () => {
  it("adds the CHECK on ClientDocument as its latest definition", () => {
    expect(baselineConstraintSql("ClientDocument_verified_not_refused_check")).toBe(
      `ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_verified_not_refused_check" CHECK (NOT ("verified" AND ("verificationRejectedAt" IS NOT NULL OR "verificationRejectedById" IS NOT NULL)));`,
    )
  })

  it("aborts with a count of violating rows before adding it", () => {
    const precheck = code.indexOf("DO $precheck$")
    expect(precheck).toBeGreaterThanOrEqual(0)
    expect(precheck).toBeLessThan(code.indexOf("ADD CONSTRAINT"))
    expect(code).toMatch(/SELECT count\(\*\) INTO violating\s+FROM "ClientDocument"\s+WHERE "verified" = true\s+AND \("verificationRejectedAt" IS NOT NULL OR "verificationRejectedById" IS NOT NULL\);/)
    expect(code).toMatch(/IF violating > 0 THEN\s+RAISE EXCEPTION/)
  })

  it("never fixes data itself", () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i)
    expect(code).not.toMatch(/NOT VALID/i)
  })
})
