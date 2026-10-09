import { describe, expect, it } from "vitest"
import {
  baselineConstraintSql,
  baselineFunctionSql,
  baselineTriggerSql,
} from "../db-baseline.test-helpers"

const migration = baselineConstraintSql("LoanApplication_countersign_complete_check")
const guard = [
  baselineFunctionSql("guardLoanApplicationProviderCountersign"),
  baselineTriggerSql("LoanApplication_require_provider_countersign_on_insert"),
  baselineTriggerSql("LoanApplication_guard_provider_countersign_update"),
].join("\n")

describe("provider countersign migration", () => {
  it("requires one complete evidence set bound to the exact consumer-signed agreement", () => {
    for (const field of [
      "agreementCountersignedAt",
      "agreementCountersignedById",
      "agreementCountersignedByName",
      "agreementCountersignedByEmail",
      "agreementCountersignatureData",
      "agreementCountersignatureSha256",
      "agreementCountersignedDocumentSha256",
    ]) {
      expect(migration).toContain(`"${field}"`)
    }
    expect(migration).toContain(
      '"agreementCountersignedDocumentSha256" = "agreementDocumentSha256"',
    )
    expect(migration).toContain(
      '"agreementCountersignedAt" >= "agreementSignedAt"',
    )
    expect(migration).toContain(
      '"agreementCountersignatureSha256" IS NOT NULL',
    )
    expect(migration).toContain(
      '"agreementCountersignedDocumentSha256" IS NOT NULL',
    )
  })

  it("guards every new disbursed application and freezes evidence after payout", () => {
    expect(guard).toContain("guardLoanApplicationProviderCountersign")
    expect(guard).toContain(`NEW."status"::TEXT = 'DISBURSED'`)
    // Countersign precedes payout, so freezing at countersign also freezes
    // the evidence after disbursement.
    expect(guard).toContain(
      "Consumer and provider signature evidence is immutable after provider countersign",
    )
    expect(guard).toContain("BEFORE INSERT ON \"LoanApplication\"")
    expect(guard).toContain("BEFORE UPDATE ON \"LoanApplication\"")
  })
})
