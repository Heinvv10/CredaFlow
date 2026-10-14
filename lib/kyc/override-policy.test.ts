import { describe, expect, it } from "vitest"
import { FACE_MISMATCH_FLOOR } from "./face-model/models"
import { overrideEligibility, type KycOverrideEligibilityInput } from "./override-policy"

const base: KycOverrideEligibilityInput = {
  kind: "EXCEPTION",
  mode: "direct",
  attempt: {
    extractionStatus: "failed",
    biometricFailureReason: "match_score_below_threshold",
    similarity: 0.33,
    faceVerdict: { samePerson: "uncertain" },
  },
  policy: {
    enabled: true,
    minRole: "ADMIN",
    secondApprover: false,
    requireStaffTotp: true,
  },
  caller: { role: "ADMIN", totpVerified: true },
}

const check = (patch: Partial<KycOverrideEligibilityInput> = {}) =>
  overrideEligibility({ ...base, ...patch })

describe("overrideEligibility", () => {
  it("allows a borderline failure at the mismatch floor", () => {
    expect(check({ attempt: { ...base.attempt!, similarity: FACE_MISMATCH_FLOOR } })).toEqual({ allowed: true })
  })

  it("refuses a face-model similarity below the mismatch floor", () => {
    expect(check({ attempt: { ...base.attempt!, similarity: 0.2999 } })).toEqual({ allowed: false, code: "clear_mismatch" })
  })

  it("refuses a VLM different verdict even above the floor", () => {
    expect(check({ attempt: { ...base.attempt!, faceVerdict: { samePerson: "different" } } })).toEqual({ allowed: false, code: "clear_mismatch" })
  })

  it("does not treat an uncertain verdict as a clear mismatch", () => {
    expect(check({ attempt: { ...base.attempt!, faceVerdict: { samePerson: "uncertain" } } })).toEqual({ allowed: true })
  })

  it("fails closed when face-match evidence has no similarity", () => {
    expect(check({ attempt: { ...base.attempt!, similarity: null } })).toEqual({ allowed: false, code: "clear_mismatch" })
  })

  it("refuses a never-exceptionable failure", () => {
    expect(check({ attempt: { ...base.attempt!, biometricFailureReason: "id_document_portrait_invalid" } })).toEqual({ allowed: false, code: "never_exceptionable" })
  })

  it("refuses when overrides are disabled", () => {
    expect(check({ policy: { ...base.policy, enabled: false } })).toEqual({ allowed: false, code: "overrides_disabled" })
  })

  it("refuses a caller below the lender's minimum role", () => {
    expect(check({ caller: { role: "BRANCH_MANAGER", totpVerified: true } })).toEqual({ allowed: false, code: "role_below_policy" })
  })

  it("allows a branch manager when that is the lender's minimum role", () => {
    expect(check({
      policy: { ...base.policy, minRole: "BRANCH_MANAGER" },
      caller: { role: "BRANCH_MANAGER", totpVerified: true },
    })).toEqual({ allowed: true })
  })

  it("refuses a non-TOTP session when the lender requires staff TOTP", () => {
    expect(check({ caller: { role: "ADMIN", totpVerified: false } })).toEqual({ allowed: false, code: "totp_required" })
  })

  it("allows a non-TOTP session when the lender does not require staff TOTP", () => {
    expect(check({
      policy: { ...base.policy, requireStaffTotp: false },
      caller: { role: "ADMIN", totpVerified: false },
    })).toEqual({ allowed: true })
  })

  it("requires the request workflow for a direct grant under dual approval", () => {
    expect(check({ policy: { ...base.policy, secondApprover: true } })).toEqual({ allowed: false, code: "second_approver_required" })
  })

  it("allows request and approval phases under dual approval", () => {
    const policy = { ...base.policy, secondApprover: true }
    expect(check({ mode: "request", policy })).toEqual({ allowed: true })
    expect(check({ mode: "approve", policy })).toEqual({ allowed: true })
  })

  it("allows in-person verification after a clear selfie mismatch", () => {
    expect(check({
      kind: "IN_PERSON",
      attempt: { ...base.attempt!, similarity: 0.1, faceVerdict: { samePerson: "different" } },
    })).toEqual({ allowed: true })
  })
})
