import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  baselineConstraintSql,
  baselineFunctionSql,
  baselineTriggerSql,
} from "@/lib/db-baseline.test-helpers"
import { FACE_MISMATCH_FLOOR } from "@/lib/kyc/face-model/models"

describe("KYC override migration", () => {
  it("pins the SQL clear-mismatch floor to the TypeScript constant", () => {
    const fn = baselineFunctionSql("kyc_exception_selfie_is_clear_mismatch")
    expect(fn).toContain(`::numeric < ${FACE_MISMATCH_FLOOR.toFixed(2)}`)
    expect(fn).toContain("{faceVerdict,samePerson}")
    expect(fn).toContain("provider_verification_failed")
  })

  it("guards direct exception writes and excludes them from composite KYC", () => {
    expect(baselineTriggerSql("ComplianceRecord_guard_clear_mismatch_kyc_exception")).toContain("guard_clear_mismatch_kyc_exception")
    expect(baselineFunctionSql("subject_has_manual_kyc_exception")).toContain("NOT \"kyc_exception_selfie_is_clear_mismatch\"")
  })

  it("guards the complete lender policy and preflights cached VERIFIED rows", () => {
    const policy = baselineFunctionSql("guard_kyc_override_policy")
    expect(policy).toContain("kycOverrideEnabled")
    expect(policy).toContain("kycOverrideMinRole")
    expect(policy).toContain("approvedWithTotp")
    expect(policy).toContain("overrideRequestId")
    expect(policy).toContain("request.\"payload\" ->> 'reason'")
    expect(policy).toContain("request.\"payload\" ->> 'method'")
    expect(baselineTriggerSql("ComplianceRecord_guard_kyc_override_policy")).toContain("DEFERRABLE INITIALLY DEFERRED")
    expect(policy).toContain("matching approved request")
    expect(baselineFunctionSql("guard_kyc_override_request_policy")).toContain("active eligible senior")
    expect(baselineTriggerSql("KycOverrideRequest_guard")).toContain("BEFORE INSERT OR UPDATE OR DELETE")
    expect(baselineFunctionSql("kyc_override_request_guard")).toContain("clock_timestamp()")
    expect(baselineTriggerSql("KycOverrideRequest_approved_requires_grant")).toContain("DEFERRABLE INITIALLY DEFERRED")
    expect(baselineFunctionSql("guard_approved_kyc_override_has_grant")).toContain("same transaction")
    const migration = fs.readFileSync(path.join(
      __dirname,
      "..",
      "..",
      "prisma/migrations/20261013213000_kyc_override_policy/migration.sql",
    ), "utf8")
    expect(migration).toContain("KYC override policy preflight found % VERIFIED client(s)")
  })

  it("pins the role and request-ledger checks", () => {
    expect(baselineConstraintSql("TenantConfig_kycOverrideMinRole_check")).toContain("BRANCH_MANAGER")
    expect(baselineConstraintSql("TenantConfig_kycOverrideMinRole_check")).toContain("ADMIN")
    expect(baselineConstraintSql("KycOverrideRequest_different_decider_check")).toContain("requestedById")
    expect(baselineConstraintSql("KycOverrideRequest_expiry_check")).toContain("7 days")
    expect(baselineTriggerSql("KycOverrideRequest_guard")).toContain("kyc_override_request_guard")
  })
})
