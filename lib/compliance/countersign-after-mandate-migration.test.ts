import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineFunctionSql, baselineTriggerSql } from "../db-baseline.test-helpers"

// What 20261016200000_countersign_after_mandate leaves in force. The rule only
// holds when it runs: countersign-after-mandate.integration.test.ts executes it.
// A later DO block patches its pricing comparison; that patch is asserted below and
// proven in Postgres by lib/non-nca-documents/ls-versioned.integration.test.ts.
const RULE_PATCH = "20261102090000_approval_guard_rule_priced"
const guard = baselineFunctionSql("guardSignedDebitMandateAuthority", { beforeMigration: RULE_PATCH })

const COUNTERSIGN_COLUMNS = [
  "agreementCountersignedAt",
  "agreementCountersignedById",
  "agreementCountersignedByName",
  "agreementCountersignedByEmail",
  "agreementCountersignatureData",
  "agreementCountersignatureSha256",
  "agreementCountersignatureEnvelopeSha256",
  "agreementCountersignedDocumentSha256",
]

describe("signed debit-mandate authority after 20261016200000", () => {
  it("lets the countersignature go NULL to value once, and only from all-NULL", () => {
    const once = guard.slice(guard.indexOf("countersign_once := COALESCE(("), guard.indexOf("), FALSE);", guard.indexOf("countersign_once := COALESCE((")))
    expect(once).toContain(`OLD."agreementSignedAt" IS NOT NULL`)
    for (const column of COUNTERSIGN_COLUMNS) expect(once).toContain(`OLD."${column}" IS NULL`)
    expect(once).toContain(`NEW."agreementCountersignedAt" IS NOT NULL`)
    expect(guard).toMatch(/OR \(\s*NOT countersign_once\s*AND \(/)
  })

  it("still freezes the mandate and the decision", () => {
    for (const column of ["debitMandateSignedAt", "debitMandateSignatureData", "debitMandateEvidence", "approvedById", "agreementSignatureData"]) {
      expect(guard).toMatch(new RegExp(`OR NEW\\."${column}"\\s+IS DISTINCT FROM OLD\\."${column}"`))
    }
    expect(guard).toContain("Signed debit-mandate authority is immutable outside an explicit return to review")
  })

  it("keeps the trigger that runs it", () => {
    expect(baselineTriggerSql("LoanApplication_guard_signed_debit_mandate_authority"))
      .toContain(`EXECUTE FUNCTION "guardSignedDebitMandateAuthority"()`)
  })
})

describe(RULE_PATCH, () => {
  const patch = readFileSync(path.join(process.cwd(), "prisma/migrations", RULE_PATCH, "migration.sql"), "utf8")

  it("replaces exactly the source shape of the rate and fee comparisons, and refuses to run if either moved", () => {
    expect(guard).toMatch(/AND new_approval #>> '\{inputs,interestRatePm\}'\n\s+= TO_JSONB\(product\."interestRatePm"\)::TEXT/)
    expect(guard).toMatch(/AND new_approval #>> '\{inputs,initiationFeePct\}'\n\s+= TO_JSONB\(product\."initiationFeePct"\)::TEXT/)
    expect(patch).toContain("rate shape changed")
    expect(patch).toContain("fee shape changed")
  })

  it("lets a rate or fee off the product row stand only on a rule of this tenant and this product, on the row's base rate", () => {
    expect(patch).toContain(`rule."tenantId" = NEW."tenantId" AND rule."productId" = product."id"`)
    expect(patch).toContain("{inputs,productVersion,pricingRuleId}")
    expect(patch).toContain(`{inputs,productVersion,baseRatePm}'' = TO_JSONB(product."interestRatePm")::TEXT`)
  })
})
