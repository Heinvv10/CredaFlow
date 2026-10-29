import { describe, expect, it } from "vitest"
import { segregationOfDutiesConflict } from "./segregation-of-duties"

describe("segregationOfDutiesConflict", () => {
  const application = { approvedById: "approver", agreementSignedMethod: "branch", agreementSignedByUserId: "witness" }

  it("names the approver as the one who may not disburse", () => {
    expect(segregationOfDutiesConflict("disburse", "approver", application)).toBe("approve_disburse")
    expect(segregationOfDutiesConflict("disburse", "witness", application)).toBeNull()
  })

  it("names the in-branch witness as the one who may not countersign", () => {
    expect(segregationOfDutiesConflict("countersign", "witness", application)).toBe("branch_sign_countersign")
    expect(segregationOfDutiesConflict("countersign", "approver", application)).toBeNull()
  })

  it("has no witness to conflict with for a portal signature", () => {
    expect(segregationOfDutiesConflict("countersign", "witness", { ...application, agreementSignedMethod: "portal" })).toBeNull()
  })

  describe("an application the decision engine approved (approved by the system user)", () => {
    const engineApproved = { ...application, approvedById: "sys", approvedBySystem: true, recklessLendingAssessedById: "assessor", incomeVerifiedById: "verifier", bureauOverrideById: "overrider" }

    it("the system user cannot disburse, as an approver cannot", () => {
      expect(segregationOfDutiesConflict("disburse", "sys", engineApproved)).toBe("approve_disburse")
    })

    it.each(["assessor", "verifier", "overrider"])("the staff member whose attestation the approval rested on (%s) may not disburse it", (who) => {
      expect(segregationOfDutiesConflict("disburse", who, engineApproved)).toBe("attester_disburse")
    })

    it("anyone else may", () => {
      expect(segregationOfDutiesConflict("disburse", "someone-else", engineApproved)).toBeNull()
    })

    it("an application a person approved is judged by the original pair only: the attester may disburse what another approved", () => {
      expect(segregationOfDutiesConflict("disburse", "assessor", { ...engineApproved, approvedBySystem: false, approvedById: "approver" })).toBeNull()
    })

    it("a missing attester never matches a missing actor", () => {
      expect(segregationOfDutiesConflict("disburse", "", { ...engineApproved, recklessLendingAssessedById: null, incomeVerifiedById: null, bureauOverrideById: null })).toBeNull()
    })
  })
})
