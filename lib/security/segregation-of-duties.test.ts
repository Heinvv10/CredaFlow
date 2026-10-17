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
})
