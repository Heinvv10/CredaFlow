import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migration 20261017090000_loan_arrears_snapshot; the rules run
// against Postgres in RUN_ARREARS_HISTORY_IT (arrears-snapshot.integration.test.ts).
describe("LoanArrearsSnapshot hand-written objects", () => {
  it("keeps history append-only", () => {
    expect(baselineTriggerSql("LoanArrearsSnapshot_append_only")).toMatch(/BEFORE UPDATE OR DELETE ON "LoanArrearsSnapshot"/)
    expect(baselineFunctionSql("guardLoanArrearsSnapshot")).toContain("Loan arrears history is append-only")
  })

  it("refuses negative figures", () => {
    expect(baselineConstraintSql("LoanArrearsSnapshot_figures_non_negative").replace(/\s+/g, " "))
      .toContain(`CHECK ("daysInArrears" >= 0 AND "arrearsCents" >= 0 AND "outstandingPrincipalCents" >= 0 AND "chargesOutstandingCents" >= 0)`)
  })
})
