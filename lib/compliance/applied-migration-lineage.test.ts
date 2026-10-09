import { describe, expect, it } from "vitest"
import { baselineConstraintSql } from "../db-baseline.test-helpers"

describe("applied migration lineage", () => {
  it("keeps the current PASQ v1/v2/v3 document constraint", () => {
    const constraint = baselineConstraintSql(
      "LoanApplication_pasq_document_complete",
    )
    expect(constraint).toContain(
      "ARRAY['pasq-v1'::text, 'pasq-v2'::text, 'pasq-v3'::text]",
    )
    expect(constraint).toContain('("pasqDocumentSha256" IS NOT NULL)')
    expect(constraint).toContain('("pasqEvidenceSha256" IS NOT NULL)')
  })
})
