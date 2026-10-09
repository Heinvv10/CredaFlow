import { describe, expect, it } from "vitest"
import { baselineConstraintSql } from "../db-baseline.test-helpers"

const migration = [
  "LoanApplication_pasq_document_complete",
  "LoanApplication_pasq_acknowledgement_bound",
  "LoanApplication_approved_pasq_bound",
].map(baselineConstraintSql).join("\n")

describe("versioned PASQ migration", () => {
  it("binds the document, evidence, client acknowledgement and approval hashes", () => {
    for (const field of [
      "pasqVersion",
      "pasqGeneratedAt",
      "pasqDocumentId",
      "pasqDocumentSha256",
      "pasqEvidence",
      "pasqEvidenceSha256",
      "pasqAcknowledgedSha256",
      "approvedPasqDocumentSha256",
    ]) {
      expect(migration).toContain(`"${field}"`)
    }
    expect(migration).toContain('("pasqAcknowledgedSha256" = "pasqDocumentSha256")')
    expect(migration).toContain('("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256")')
  })
})
