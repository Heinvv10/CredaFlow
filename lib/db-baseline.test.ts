import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import { BASELINE_MIGRATION_DIR, readBaselineSql } from "./db-baseline.test-helpers"

/**
 * Prisma applies migrations in lexicographic order of their directory names.
 * Later migrations are expected; one that sorts BEFORE the baseline would run
 * against an empty database and could never have been part of the squash.
 */
function expectBaselineFirst(migrations: string[]) {
  expect(migrations).toContain(BASELINE_MIGRATION_DIR)
  for (const m of migrations) {
    if (m !== BASELINE_MIGRATION_DIR) expect(m > BASELINE_MIGRATION_DIR, `${m} sorts before the baseline`).toBe(true)
  }
}

describe("the squashed baseline migration", () => {
  it("is the first migration, and every other migration sorts after it", () => {
    const dir = path.join(__dirname, "..", "prisma", "migrations")
    const migrations = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
    expectBaselineFirst(migrations)
  })

  it("allows migrations added after the baseline and rejects one that sorts before it", () => {
    expect(() => expectBaselineFirst(["29990101000000_later_change", BASELINE_MIGRATION_DIR])).not.toThrow()
    expect(() => expectBaselineFirst([BASELINE_MIGRATION_DIR, "20200101000000_earlier_change"])).toThrow(/20200101000000_earlier_change/)
    expect(() => expectBaselineFirst(["29990101000000_later_change"])).toThrow()
  })

  it("names no lender", () => {
    expectNoOtherLender(readBaselineSql())
  })

  it("writes no tenant data: its only row is the statutory proclaimed holiday", () => {
    // Per-tenant rows (message templates) are seeded by the seed, never by a
    // migration: a migration that inserts for one tenant silently does nothing
    // for every other one.
    // Function bodies insert and update too (audit rows, projections); only
    // top-level statements write data when the migration runs.
    const topLevel = readBaselineSql().replace(/^CREATE OR REPLACE FUNCTION[\s\S]*?^\$function\$;$/gm, "")
    const writes = topLevel.match(/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+"?\w+"?/gim) ?? []
    expect(writes.map((w) => w.trim())).toEqual(['INSERT INTO "SaProclaimedPublicHoliday"'])
  })
})
