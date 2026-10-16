import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineConstraintSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migration 20261016190100_selfie_link_portal_handoff. The rule
// is proved against Postgres by RUN_PORTAL_HANDOFF_IT
// (selfie-link-portal-handoff.integration.test.ts).
describe("SelfieCaptureToken issuer CHECK", () => {
  it("allows no issuer exactly on a PORTAL link", () => {
    const sql = baselineConstraintSql("SelfieCaptureToken_issuer_matches_channel")
    expect(sql).toContain(`ALTER TABLE "SelfieCaptureToken"`)
    expect(sql.replace(/\s+/g, " ")).toContain(`CHECK (("createdById" IS NULL) = ("channel" = 'PORTAL'))`)
  })

  it("is the migration that relaxes NOT NULL on createdById", () => {
    const migration = readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20261016190100_selfie_link_portal_handoff", "migration.sql"), "utf8")
    expect(migration).toContain(`ALTER TABLE "SelfieCaptureToken" ALTER COLUMN "createdById" DROP NOT NULL;`)
  })
})
