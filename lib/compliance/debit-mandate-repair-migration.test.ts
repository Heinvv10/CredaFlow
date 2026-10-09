import { describe, expect, it } from "vitest"
import {
  baselineConstraintSql,
  baselineFunctionSql,
} from "../db-baseline.test-helpers"

const repair = [
  baselineConstraintSql("LoanApplication_debit_mandate_preparation_complete"),
  baselineConstraintSql("LoanApplication_debit_mandate_signature_complete"),
  baselineFunctionSql("guardLoanApplicationDebitMandateBankTupleRepair"),
].join("\n")

describe("debit-mandate forward repair migration", () => {
  it("reinstalls NULL-safe hashes and the complete bank-tuple gate", () => {
    for (const field of [
      "debitMandateDraftSha256",
      "debitMandateEvidenceSha256",
      "debitMandateSignatureSha256",
      "debitMandateDocumentSha256",
    ]) {
      expect(repair).toContain(`"${field}" IS NOT NULL`)
    }
    expect(repair).toContain("canonicalBankName")
    expect(repair).toContain("bankBranchCode")
    expect(repair).toContain("canonicalAccountType")
    expect(repair).toContain("guardLoanApplicationDebitMandateBankTupleRepair")
  })
})
