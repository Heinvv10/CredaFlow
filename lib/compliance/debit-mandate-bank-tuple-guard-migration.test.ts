import { describe, expect, it } from "vitest"
import {
  baselineFunctionSql,
  baselineTriggerSql,
} from "../db-baseline.test-helpers"
import { UNDETERMINED_EXTRACTED_ACCOUNT_TYPE } from "./debit-mandate"

const migration = baselineFunctionSql(
  "guardLoanApplicationDebitMandateBankTupleRepair",
)

// The TypeScript gate (`verifiedBankStatementEvidence`) admits the payout; this
// Postgres guard admits the DISBURSED write. A statement the first accepts and
// the second refuses produces the worst outcome available: the route commits to
// the payout and the trigger raises 23514 mid-transaction, after both
// signatures are already recorded and with no staff-side remedy. Every
// assertion here exists to make relaxing one side without the other fail in CI
// instead of at someone's payout.
describe("the DISBURSED bank-tuple guard stays in step with the TS gate", () => {
  it("treats an undetermined account type as silence, not as a mismatch", () => {
    expect(migration).toContain(
      `IN ('', '${UNDETERMINED_EXTRACTED_ACCOUNT_TYPE}')`,
    )
  })

  it("still compares a DETERMINED account type against the record", () => {
    // The relaxation is to silence only. If this disappears the guard has
    // stopped checking the account type at all, which is a different and
    // larger change than the one this migration made.
    expect(migration).toContain('"canonicalAccountType"')
    expect(migration).toContain('client."accountType"::TEXT')
  })

  it("still requires the account number and the bank name to match", () => {
    expect(migration).toContain('client."bankAccountNumber"')
    expect(migration).toContain('"canonicalBankName"(client."bankName")')
  })

  it("does not compare the statement's branch code against the record", () => {
    // Removed on 2026-08-13 and asserted absent here: SA banks run one
    // universal code and mostly do not print it, so this leg blocked honest
    // clients while checking the bank a second time. `bankBranchCode IS NOT
    // NULL` is the only mention that may remain — a payout still needs a code
    // on file, it just is not evidence about the statement.
    const branchMentions = migration.match(/bankBranchCode/g) ?? []
    expect(branchMentions).toHaveLength(1)
    expect(migration).toContain('client."bankBranchCode" IS NOT NULL')
  })

  it("keeps the DEBIT_ORDER scoping on the triggers' WHEN clauses", () => {
    // The DEBIT_ORDER scoping lives on the triggers, not in the function.
    // Losing it would start guarding EFT payouts that have no mandate at all.
    expect(
      baselineTriggerSql("LoanApplication_repair_debit_mandate_bank_tuple_insert"),
    ).toContain(
      `WHEN ((new."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod"))`,
    )
    expect(
      baselineTriggerSql("LoanApplication_repair_debit_mandate_bank_tuple_update"),
    ).toContain(
      `WHEN (((old."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod") OR (new."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod")))`,
    )
  })

  it("still COALESCEs both containers for every payout key", () => {
    // The TS reader (`extractedFieldValue`) mirrors these arms. If the SQL ever
    // stops falling through to the top level, or the TS side stops, the two
    // read different values off the same document — the route admits a payout
    // on a field it cannot see and this guard rejects it mid-transaction.
    // Measured on PG16: a `{fields:{bankName},accountType:{value:"Cheque"}}`
    // statement against a SAVINGS record is BLOCKED here, and the TS gate
    // refuses it too ("sees a top-level key when a fields object exists
    // without it" in debit-mandate.test.ts).
    for (const key of ["accountNumber", "bankName", "accountType"]) {
      expect(migration).toContain(`-> 'fields' -> '${key}' ->> 'value'`)
      expect(migration).toContain(`-> 'fields' ->> '${key}'`)
      expect(migration).toContain(`-> '${key}' ->> 'value'`)
      expect(migration).toContain(`->> '${key}'`)
    }
  })
})
