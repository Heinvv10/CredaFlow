import { describe, expect, it } from "vitest"
import {
  baselineFunctionSql,
  readBaselineSql,
} from "../db-baseline.test-helpers"

const FUNCTION_NAME = "guardLoanApplicationDebitMandateBankTupleRepair"

/**
 * The executable SQL, with `--` comments stripped.
 *
 * The function body carries rationale comments that may legitimately NAME the
 * things it removed — the branchCode leg is gone for a documented reason. A
 * bare `not.toContain("branchCode")` over the raw body would then fail on the
 * explanation rather than on the code, which would push the next author to
 * delete the reasoning to make the test pass. Assert on what Postgres actually
 * executes.
 */
const sql = baselineFunctionSql(FUNCTION_NAME)
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")

describe("the live DISBURSED bank-tuple guard", () => {
  it("does not compare a branch code against the statement", () => {
    // SA retail banks run one universal branch code and mostly do not print it,
    // so this leg compared '' against the record and refused correct payouts.
    // Re-deriving it from the bank instead would block clients holding a legacy
    // per-branch code. The branch code is functionally determined by the bank,
    // so asserting bank AND branch asserts the bank twice.
    //
    // The TypeScript half of this pair is asserted in debit-mandate.test.ts
    // ("binds a branch code that DISAGREES with the record"). Both halves must
    // move together: relaxing only the route produces a payout the route accepts
    // and this trigger then rejects mid-transaction with 23514.
    expect(sql).not.toContain("branchCode")
  })

  it("still requires a branch code to be ON FILE", () => {
    // Dropping the comparison is not the same as dropping the field. A payout
    // still needs a branch code; it just is not evidence about the statement.
    expect(sql).toContain('client."bankBranchCode" IS NOT NULL')
  })

  it("still binds the account number, the bank and the account type", () => {
    // The legs that actually stop money reaching the wrong account. If any of
    // these disappears, the guard has stopped guarding.
    expect(sql).toContain('client."bankAccountNumber"')
    expect(sql).toContain('"canonicalBankName"')
    expect(sql).toContain('"canonicalAccountType"')
    expect(sql).toContain('client."accountType"')
  })

  it("still refuses an OTHER account for a debit order", () => {
    // Every trigger on this function is scoped to repaymentMethod =
    // 'DEBIT_ORDER', and OTHER cannot be a debit-order account because the
    // Netcash AVS wire has no value to send for it. This allow-list is what
    // enforces that at the database.
    expect(sql).toContain("client.\"accountType\" IN ('CHEQUE', 'SAVINGS')")
  })

  it("runs only from triggers scoped to DEBIT_ORDER", () => {
    // The triggers carry `WHEN (... repaymentMethod = 'DEBIT_ORDER')` clauses.
    // A trigger on this function without one would silently widen the guard
    // to EFT disbursements, which have no signed mandate and would then fail
    // at payout.
    const triggers = readBaselineSql()
      .split("\n")
      .filter((line) =>
        line.startsWith("CREATE TRIGGER ") &&
        line.includes(`EXECUTE FUNCTION "${FUNCTION_NAME}"()`),
      )
    expect(triggers).toHaveLength(2)
    for (const trigger of triggers) {
      expect(trigger).toMatch(
        /WHEN \(.*"repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod".*\) EXECUTE FUNCTION/,
      )
    }
  })
})
