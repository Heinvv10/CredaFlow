/**
 * Static proof for migration 20261013120000_credit_checks_v1: the SQL holds
 * the same rule as the TypeScript. What the trigger and CHECK do when they run
 * is proven against Postgres by db-enforcement.integration.test.ts.
 */
import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"
import { CLEAR_REASON_MIN_LENGTH } from "./policy"

describe("migration 20261013120000_credit_checks_v1", () => {
  it("guards every status change of LoanApplication, before the write", () => {
    expect(baselineTriggerSql("LoanApplication_a0_guard_open_check_flags")).toContain(
      'BEFORE UPDATE OF status ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationOpenCheckFlags"()',
    )
  })

  it("refuses the transition into APPROVED while an OPEN flag of the same tenant's application exists", () => {
    const fn = baselineFunctionSql("guardLoanApplicationOpenCheckFlags")
    expect(fn).toContain("NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED'")
    expect(fn).toContain(`f."applicationId" = NEW.id`)
    expect(fn).toContain(`f."tenantId" = NEW."tenantId"`)
    expect(fn).toContain("f.status = 'OPEN'")
    expect(fn).toContain("RAISE EXCEPTION")
  })

  it("demands the same reason length as the clear route", () => {
    const check = baselineConstraintSql("ApplicationCheckFlag_clearance_complete")
    expect(check).toContain(`char_length(btrim(coalesce("clearReason", ''))) >= ${CLEAR_REASON_MIN_LENGTH}`)
    expect(check).toContain(`"clearedById" IS NOT NULL AND "clearedAt" IS NOT NULL`)
  })
})
