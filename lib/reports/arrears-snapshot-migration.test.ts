import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migration 20261017090000_loan_arrears_snapshot; the rules run
// against Postgres in RUN_ARREARS_HISTORY_IT (arrears-snapshot.integration.test.ts).
describe("LoanArrearsSnapshot hand-written objects", () => {
  it.each(["LoanArrearsSnapshot", "ArrearsSnapshotRun"])("keeps %s append-only: no UPDATE, DELETE or TRUNCATE", (table) => {
    expect(baselineTriggerSql(`${table}_append_only`)).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON "${table}"`))
    expect(baselineTriggerSql(`${table}_guard_truncate`)).toMatch(new RegExp(`BEFORE TRUNCATE ON "${table}"\\s+FOR EACH STATEMENT`))
    expect(baselineFunctionSql("guardLoanArrearsSnapshot")).toContain("Loan arrears history is append-only")
  })

  it("refuses negative figures", () => {
    expect(baselineConstraintSql("LoanArrearsSnapshot_figures_non_negative").replace(/\s+/g, " "))
      .toContain(`CHECK ("daysInArrears" >= 0 AND "arrearsCents" >= 0 AND "outstandingPrincipalCents" >= 0 AND "chargesOutstandingCents" >= 0)`)
    expect(baselineConstraintSql("ArrearsSnapshotRun_loanCount_non_negative")).toContain(`CHECK ("loanCount" >= 0)`)
  })
})
