import { describe, expect, it } from "vitest"
import { planApproval } from "./plan"
import type { MatrixLevel } from "./types"

const levels: MatrixLevel[] = [
  { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
  { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
  { level: 3, name: "Credit committee", role: "ADMIN", slaHours: 48, committee: true },
]
const base = {
  required: 2, levels, steps: [] as Array<{ level: number; approverId: string }>, userId: "u1", inputStaffIds: ["maker"],
  authority: { level: 2, via: "ROLE" as const, delegationId: null }, automated: false, committeeDecision: null as null | { decision: "APPROVED" | "DECLINED" | "DEFERRED" },
  committeeRecorderIds: [] as string[],
}

describe("planApproval", () => {
  it("level 1 of 2 is recorded and leaves the application under review", () => {
    expect(planApproval(base)).toMatchObject({ kind: "record", level: 1, requiredLevels: 2 })
  })
  it("the last required level completes the chain", () => {
    expect(planApproval({ ...base, steps: [{ level: 1, approverId: "u0" }] })).toMatchObject({ kind: "final", level: 2 })
  })
  it("one level required: that one approval is the final one", () => {
    expect(planApproval({ ...base, required: 1 })).toMatchObject({ kind: "final", level: 1 })
  })
  it("no staff chain required: the approval is final with no step", () => {
    expect(planApproval({ ...base, required: 0, authority: { level: 0, via: "ROLE", delegationId: null } })).toMatchObject({ kind: "final", level: 0 })
  })
  it("the decision engine may approve only where no chain is required", () => {
    expect(planApproval({ ...base, automated: true })).toMatchObject({ kind: "refuse", status: 409, code: "AUTOMATION_NOT_PERMITTED" })
    expect(planApproval({ ...base, automated: true, required: 0 })).toMatchObject({ kind: "final" })
  })
  it("the maker (who captured it or changed its inputs) never approves, at any level", () => {
    expect(planApproval({ ...base, userId: "maker" })).toMatchObject({ kind: "refuse", status: 403, code: "MAKER_CANNOT_APPROVE" })
    expect(planApproval({ ...base, userId: "maker", required: 0 })).toMatchObject({ kind: "final" })
  })
  it("a person approves once: the next level needs someone else", () => {
    expect(planApproval({ ...base, steps: [{ level: 1, approverId: "u1" }] })).toMatchObject({ kind: "refuse", status: 409, code: "ALREADY_APPROVED" })
  })
  it("an approver without the authority for the next level is refused, naming the role it needs", () => {
    const refused = planApproval({ ...base, steps: [{ level: 1, approverId: "u0" }], authority: { level: 1, via: "ROLE", delegationId: null } })
    expect(refused).toMatchObject({ kind: "refuse", status: 403, code: "LEVEL_AUTHORITY_REQUIRED" })
    expect((refused as { error: string }).error).toContain("Branch manager")
    expect((refused as { error: string }).error).toContain("BRANCH_MANAGER")
  })
  it("an approver below level 1 is refused too", () => {
    expect(planApproval({ ...base, authority: { level: 0, via: "ROLE", delegationId: null } })).toMatchObject({ kind: "refuse", code: "LEVEL_AUTHORITY_REQUIRED" })
  })
  it("a delegated authority approves as the role would, and the step says it was delegated", () => {
    expect(planApproval({ ...base, authority: { level: 2, via: "DELEGATION", delegationId: "d1" } })).toMatchObject({ kind: "record", via: "DELEGATION", delegationId: "d1" })
  })
  it("the committee's level waits for a committee approval decision on record", () => {
    const atCommittee = { ...base, required: 3, steps: [{ level: 1, approverId: "u0" }, { level: 2, approverId: "u9" }], authority: { level: 3, via: "ROLE" as const, delegationId: null } }
    expect(planApproval(atCommittee)).toMatchObject({ kind: "refuse", status: 409, code: "COMMITTEE_DECISION_REQUIRED" })
    expect(planApproval({ ...atCommittee, committeeDecision: { decision: "DEFERRED" } })).toMatchObject({ kind: "refuse", code: "COMMITTEE_DECISION_REQUIRED" })
    expect(planApproval({ ...atCommittee, committeeDecision: { decision: "DECLINED" } })).toMatchObject({ kind: "refuse", code: "COMMITTEE_DECLINED" })
    expect(planApproval({ ...atCommittee, committeeDecision: { decision: "APPROVED" } })).toMatchObject({ kind: "final", level: 3 })
  })
  it("whoever recorded a committee decision cannot give the committee level's approval", () => {
    const atCommittee = { ...base, required: 3, steps: [{ level: 1, approverId: "u0" }, { level: 2, approverId: "u9" }], authority: { level: 3, via: "ROLE" as const, delegationId: null }, committeeDecision: { decision: "APPROVED" as const } }
    expect(planApproval({ ...atCommittee, committeeRecorderIds: ["u1"] })).toMatchObject({ kind: "refuse", status: 409, code: "COMMITTEE_RECORDER_CANNOT_APPROVE" })
    expect(planApproval({ ...atCommittee, committeeRecorderIds: ["someone-else"] })).toMatchObject({ kind: "final", level: 3 })
  })
})
