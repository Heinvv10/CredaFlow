/**
 * Static proof for migration 20261014190000_credit_check_expense_understated:
 * the one schema change goal 2026-10-14 approves — one additive enum value,
 * matching prisma/schema.prisma — and nothing else. That an OPEN flag of the
 * new check blocks approval is proven against Postgres by
 * expense-understated.integration.test.ts.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(__dirname, "..", "..")
const migration = readFileSync(join(root, "prisma/migrations/20261014190000_credit_check_expense_understated/migration.sql"), "utf8")
const statements = migration.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean)

describe("migration 20261014190000_credit_check_expense_understated", () => {
  it("adds EXPENSE_UNDERSTATED to CreditCheck and does nothing else", () => {
    expect(statements).toEqual([`ALTER TYPE "CreditCheck" ADD VALUE 'EXPENSE_UNDERSTATED'`])
  })

  it("matches the schema's enum", () => {
    const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8")
    expect(/enum CreditCheck \{([^}]*)\}/.exec(schema)![1].split(/\s+/).filter(Boolean)).toContain("EXPENSE_UNDERSTATED")
  })
})
