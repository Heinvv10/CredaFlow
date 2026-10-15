import { describe, expect, it } from "vitest"
import {
  baselineConstraintSql,
  baselineTriggerSql,
  readBaselineSql,
} from "../db-baseline.test-helpers"
import { readPrismaSchema } from "@/prisma/schema-source"

const schema = readPrismaSchema()

describe("loan repayment-method database enforcement", () => {
  it("models the approval decision as a dedicated EFT or debit-order enum", () => {
    expect(schema).toContain("enum LoanRepaymentMethod")
    expect(schema).toContain("repaymentMethod")
    expect(schema).toMatch(
      /enum LoanRepaymentMethod\s*{[\s\S]*?EFT\s+DEBIT_ORDER\s*}/,
    )
  })

  it("makes debit-mandate enforcement method-specific", () => {
    expect(readBaselineSql()).toContain(
      `CREATE TYPE "LoanRepaymentMethod" AS ENUM ('EFT', 'DEBIT_ORDER');`,
    )
    expect(
      baselineConstraintSql("LoanApplication_repayment_method_lifecycle"),
    ).toContain('"LoanApplication_repayment_method_lifecycle"')
    expect(
      baselineConstraintSql("LoanApplication_eft_has_no_signed_debit_authority"),
    ).toMatch(/"repaymentMethod" IS DISTINCT FROM 'EFT'::"LoanRepaymentMethod"/)

    for (const [trigger, fn] of [
      ["LoanApplication_require_debit_mandate_on_insert", "guardLoanApplicationDebitMandate"],
      ["LoanApplication_repair_debit_mandate_bank_tuple_insert", "guardLoanApplicationDebitMandateBankTupleRepair"],
      ["LoanApplication_guard_debit_mandate_contract_insert", "guardLoanApplicationDebitMandateContractTerms"],
    ] as const) {
      const sql = baselineTriggerSql(trigger)
      expect(sql).toMatch(
        /new\."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod"/,
      )
      expect(sql).toContain(`EXECUTE FUNCTION "${fn}"()`)
    }
  })

  it("lets a repayment-method-only write skip unrelated legacy evidence revalidation", () => {
    const guardedTriggers = [
      [
        "LoanApplication_a_lock_pasq_document_on_update",
        "lockLoanApplicationPasqDocument",
      ],
      [
        "LoanApplication_guard_branch_signer_tenant_update",
        "guardLoanApplicationBranchSignerTenant",
      ],
      [
        "LoanApplication_guard_provider_countersign_update",
        "guardLoanApplicationProviderCountersign",
      ],
      [
        "LoanApplication_guard_provider_signer_tenant_update",
        "guardLoanApplicationProviderSignerTenant",
      ],
      [
        "LoanApplication_guard_signed_debit_mandate_authority",
        "guardSignedDebitMandateAuthority",
      ],
    ] as const

    for (const [trigger, fn] of guardedTriggers) {
      const sql = baselineTriggerSql(trigger)
      expect(sql).toContain(
        `(to_jsonb(new.*) - 'repaymentMethod'::text) IS DISTINCT FROM (to_jsonb(old.*) - 'repaymentMethod'::text)`,
      )
      expect(sql).toContain(`EXECUTE FUNCTION "${fn}"()`)
    }
  })

  it("leaves no temporary backfill object behind", () => {
    const baseline = readBaselineSql()
    expect(baseline).not.toContain("_repaymentMethodBackfillBypass")
    expect(baseline).not.toContain("_RepaymentMethodBackfillConstraint")
    expect(baseline).not.toContain("scopeLoanApplicationRepaymentMethodBackfill")
    expect(baseline).not.toContain("LoanApplication_00_scope_repayment_method_backfill")
  })
})
