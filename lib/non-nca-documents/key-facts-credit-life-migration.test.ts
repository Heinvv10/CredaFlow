import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// Static pin on 20261101090000_key_facts_no_credit_life. The rule runs against Postgres in
// app/api/applications/[id]/decide/decide-key-facts.integration.test.ts; what is pinned here is that
// the CHECK leaves every NCA_PASQ row alone (its first branch is true for them) and judges nothing but ACCEPTED cover.
const sql = readFileSync("prisma/migrations/20261101090000_key_facts_no_credit_life/migration.sql", "utf8")
const code = sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim()

describe("LoanApplication_key_facts_no_credit_life", () => {
  it("is one CHECK that holds for every NCA_PASQ row and for any KEY_FACTS row that is not approved or carrying ACCEPTED cover", () => {
    expect(code).toBe(
      `ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_key_facts_no_credit_life" CHECK ( "disclosureRegime" <> 'KEY_FACTS' OR "status"::TEXT NOT IN ('APPROVED', 'DISBURSED') OR "creditLifeElection" IS DISTINCT FROM 'ACCEPTED' );`,
    )
  })

  it("touches no other object", () => {
    expect(code.match(/\b(CREATE|DROP|ALTER|UPDATE|DELETE|INSERT)\b/g)).toEqual(["ALTER"])
  })
})
