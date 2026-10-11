import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineTriggerSql } from "../db-baseline.test-helpers"

describe("DISBURSEMENT_EXCEPTION compliance records", () => {
  it("are refused by a validated CHECK now that the outage trigger is gone", () => {
    expect(() => baselineTriggerSql("ComplianceRecord_guard_outage_disbursement_exception")).toThrow(/dropped by/)
    const check = baselineConstraintSql("ComplianceRecord_no_disbursement_exception")
    expect(check).toMatch(/^ALTER TABLE "ComplianceRecord" ADD CONSTRAINT /)
    expect(check).toContain(`CHECK ((type <> 'DISBURSEMENT_EXCEPTION'::"ComplianceType"))`)
    expect(check).not.toContain("NOT VALID")
  })
})
