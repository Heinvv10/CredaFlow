import { describe, expect, it } from "vitest"
import { baselineFunctionSql, baselineTriggerSql } from "../db-baseline.test-helpers"

// What 20261016200000_countersign_after_mandate leaves in force. The rule only
// holds when it runs: countersign-after-mandate.integration.test.ts executes it.
const guard = baselineFunctionSql("guardSignedDebitMandateAuthority")

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
