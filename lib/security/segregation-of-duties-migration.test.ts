import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "../db-baseline.test-helpers"

// What 20261016200100 and 20261016200200 leave in force. The rules only hold
// when they run: lib/security/segregation-of-duties.integration.test.ts.
describe("segregation of duties in the migrations", () => {
  it("guards updates and inserts with one function", () => {
    for (const trigger of ["LoanApplication_z_guard_segregation_of_duties", "LoanApplication_z_require_segregation_of_duties_on_insert"]) {
      expect(baselineTriggerSql(trigger)).toContain(`EXECUTE FUNCTION "guardLoanApplicationSegregationOfDuties"()`)
    }
    expect(baselineTriggerSql("LoanApplication_z_require_segregation_of_duties_on_insert")).toMatch(/BEFORE INSERT ON "LoanApplication"/)
    const fn = baselineFunctionSql("guardLoanApplicationSegregationOfDuties")
    expect(fn).toContain("IF TG_OP = 'INSERT' THEN")
    expect(fn).toContain(`NEW."disbursedById" = NEW."approvedById"`)
    expect(fn).toContain(`NEW."agreementSignedByUserId" = NEW."agreementCountersignedById"`)
    expect(fn).toContain(`u."active" = TRUE`)
  })

  it("ties the disburser to a user of the same tenant", () => {
    expect(baselineConstraintSql("LoanApplication_tenantId_disbursedById_fkey"))
      .toContain(`FOREIGN KEY ("tenantId", "disbursedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT`)
  })

  it("freezes a recorded consumer signature unless it is cleared whole", () => {
    expect(baselineTriggerSql("LoanApplication_guard_consumer_signature_frozen")).toContain(`EXECUTE FUNCTION "guardLoanApplicationConsumerSignature"()`)
    const fn = baselineFunctionSql("guardLoanApplicationConsumerSignature")
    for (const column of ["agreementSignedMethod", "agreementSignedByUserId", "agreementSignedByIp", "agreementSignatureData"]) {
      expect(fn).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`)
      expect(fn).toContain(`AND NEW."${column}" IS NULL`)
    }
  })

  it("makes every payout dual-approval while the setting is on", () => {
    expect(baselineFunctionSql("guardPayout")).toContain(`threshold IS NULL OR segregated IS NOT FALSE OR NEW."amountCents" >= threshold`)
  })
})
