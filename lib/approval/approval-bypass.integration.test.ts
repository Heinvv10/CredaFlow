/**
 * The approval matrix against the breaker's attacks (real Postgres): each one got an application approved with fewer or other
 * approvers than the matrix demands, and each must now be refused by the application and, where it can be, by the database.
 * See approval.integration.test.ts.
 */
import { randomUUID } from "node:crypto"
import { expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { decideApplication } from "@/app/api/applications/[id]/decide/decide-application"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { gateApproval } from "./chain"
import { recordCommitteeDecision } from "./committee"
import { grantDelegation, revokeDelegation } from "./delegations"
import { MATRIX_KIND } from "./types"
import { TODAY, app, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, refusal, registerApprovalFixture, sql, statusOf, stepsOf, suite, t, underReview } from "./approval.integration-fixture"

const day = 86_400_000
const M = {
  name: "Bypass matrix", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 1,
  levels: [
    { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
    { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
    { level: 3, name: "Credit committee", role: "SUPER_ADMIN", slaHours: 48, committee: true },
  ],
  rules: [
    { id: "small", name: "Small", when: { amountMaxCents: 200_000 }, requiredLevels: 0 },
    { id: "mid", name: "Mid", when: { amountMinCents: 400_000 }, requiredLevels: 2 },
    { id: "big", name: "Big", when: { amountMinCents: 700_000 }, requiredLevels: 3 },
    { id: "risky", name: "Risky grade", when: { riskGradeRankMin: 3 }, requiredLevels: 3 },
  ],
}
const window = () => ({ validFrom: new Date(), validTo: new Date(Date.now() + 30 * day) })
const committee = (actor: typeof as.checker, applicationId: string, decision: "APPROVED" | "DECLINED", rationale: string) =>
  inTenant(() => recordCommitteeDecision({ tenantId: ids.tenant, actor, applicationId, decision: { decision, meetingDate: TODAY, attendees: ["Member One", "Member Two", "Member Three"], conditions: [], rationale } }))
const gradeWritten = (applicationId: string, rank: number) => db.$transaction([
  db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"), // skips only the rule-set FK fixture; the CHECKs still apply
  db.$executeRawUnsafe(`UPDATE "LoanApplication" SET "riskGrade"='D', "riskGradeRank"=${rank}, "riskGradedAt"=now(), "riskGradeVersionId"='fake-ver' WHERE "id"='${applicationId}'`),
])
async function atCommittee(id: string) {
  await underReview(id, { amount: 800_000 })
  expect((await approveAs("la1", id)).status).toBe(200)
  expect((await approveAs("bm", id)).status).toBe(200)
}

suite("approval matrix: bypass attempts (real Postgres)", () => {
  registerApprovalFixture()

  it("setup: the matrix is approved by a SUPER_ADMIN", async () => {
    await approveMatrix(M)
  })

  it("a delegation cannot be self-granted from a higher role: not for the recorder, not for a friend; and the database refuses a recorder-delegate", async () => {
    const base = { delegatorId: ids.checker, level: 3, maxAmountCents: 2_000_000_000, ...window(), reason: "I need this authority now" }
    await expect(inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.ad, delegation: { ...base, delegateId: ids.ad } }))).rejects.toMatchObject({ code: "INVALID" })
    await expect(inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.ad, delegation: { ...base, delegateId: ids.la2 } }))).rejects.toMatchObject({ code: "INVALID" })
    const insert = (createdBy: string) => sql(`INSERT INTO "ApprovalDelegation" ("id","tenantId","delegatorId","delegateId","level","maxAmountCents","validFrom","validTo","reason","createdById") VALUES ('d-${randomUUID()}','${ids.tenant}','${ids.checker}','${ids.ad}',3,100,now(),now() + interval '5 days','a proper reason here','${createdBy}')`)
    expect(await refusal(insert(ids.ad))).toContain("ApprovalDelegation_shape")
    await insert(ids.checker)
  })

  it("a committee DECLINED is overturned only by a different recorder who holds the committee level's role", async () => {
    await atCommittee("bp-decl")
    await committee(as.checker, "bp-decl", "DECLINED", "Committee declined: too risky.")
    await expect(committee(as.checker, "bp-decl", "APPROVED", "Changed my mind alone.")).rejects.toMatchObject({ code: "OVERTURN_NEEDS_ANOTHER_RECORDER" })
    await expect(committee(as.ad, "bp-decl", "APPROVED", "An administrator overturns it.")).rejects.toMatchObject({ code: "FORBIDDEN" })
    // Nor a delegate of the committee's level: a decline is overturned by a member who holds the role.
    const deputy = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.checker, delegation: { delegateId: ids.la2, level: 3, maxAmountCents: 2_000_000_000, ...window(), reason: "Deputising for the committee chair" } }))
    await expect(committee(as.la2, "bp-decl", "APPROVED", "A delegate overturns it.")).rejects.toMatchObject({ code: "FORBIDDEN" })
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.checker, id: deputy.id }))
    expect(await db.creditCommitteeDecision.count({ where: { applicationId: "bp-decl" } })).toBe(1)
    await committee(as.checker2, "bp-decl", "APPROVED", "A second member re-heard it.")
    expect(await db.creditCommitteeDecision.count({ where: { applicationId: "bp-decl" } })).toBe(2)
  })

  it("the database refuses the same overturn written directly", async () => {
    await atCommittee("bp-decl2")
    await committee(as.checker, "bp-decl2", "DECLINED", "Committee declined: too risky.")
    const theCase = await caseOf("bp-decl2")
    const insertFor = (by: string) => sql(`INSERT INTO "CreditCommitteeDecision" ("id","tenantId","caseId","applicationId","level","decision","meetingDate","conditions","rationale","recordedById") VALUES ('c-${randomUUID()}','${ids.tenant}','${theCase.id}','bp-decl2',3,'APPROVED',now(),'[]'::jsonb,'a proper rationale here','${by}')`)
    expect(await refusal(insertFor(ids.checker))).toContain("overturn")
    await insertFor(ids.checker2)
  })

  it("a delegate cannot act on the authority of someone who already approved the application, or who made it", async () => {
    const granted = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.bm, delegation: { delegateId: ids.la2, level: 2, maxAmountCents: 2_000_000_000, ...window(), reason: "Covering for my leave" } }))
    await underReview("bp-deleg", { amount: 500_000 })
    expect((await approveAs("bm", "bp-deleg")).status).toBe(200)
    expect(await approveAs("la2", "bp-deleg")).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    expect(await statusOf("bp-deleg")).toBe("UNDER_REVIEW")
    expect(await stepsOf("bp-deleg")).toHaveLength(1)
    // The maker's own authority, through his delegate.
    await underReview("bp-makerdel", { amount: 500_000, inputStaff: [ids.bm] })
    expect((await approveAs("la1", "bp-makerdel")).status).toBe(200)
    expect(await approveAs("la2", "bp-makerdel")).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    expect(await statusOf("bp-makerdel")).toBe("UNDER_REVIEW")
    // The database refuses it too: a step on a delegation whose delegator already has a step on the case, and a delegation that is no delegation.
    const theCase = await caseOf("bp-deleg")
    const step = (approver: string, delegation: string) => sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via","delegationId") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','bp-deleg',2,'${approver}','DELEGATION','${delegation}')`)
    expect(await refusal(step(ids.la2, granted.id))).toContain("delegator")
    expect(await refusal(step(ids.la2, "no-such-delegation"))).toMatch(/delegation|foreign key/i)
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: granted.id }))
  })

  it("a delegator whose delegate already approved on their authority cannot approve as well", async () => {
    const granted = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.bm, delegation: { delegateId: ids.la2, level: 2, maxAmountCents: 2_000_000_000, ...window(), reason: "Covering for my leave" } }))
    await underReview("bp-reverse", { amount: 800_000 })
    expect((await approveAs("la1", "bp-reverse")).status).toBe(200)
    expect((await approveAs("la2", "bp-reverse")).status).toBe(200)
    expect((await stepsOf("bp-reverse"))[1]).toMatchObject({ level: 2, approverId: ids.la2, via: "DELEGATION", delegationId: granted.id })
    expect(await approveAs("bm", "bp-reverse")).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    const theCase = await caseOf("bp-reverse")
    expect(await refusal(sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','bp-reverse',3,'${ids.bm}','ROLE')`))).toContain("delegate already approved")
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: granted.id }))
  })

  it("the requirement follows the facts: an engine attempt before the grade is written freezes nothing, and a later grade raises it, never lowers it", async () => {
    await underReview("bp-grade", { amount: 300_000 })
    const row = await db.loanApplication.findUniqueOrThrow({ where: { id: "bp-grade" } })
    const gate = await inTenant(() => gateApproval({ tenantId: ids.tenant, automated: true, user: { id: ids.la1, email: "sys@x.invalid", role: "LOAN_ADMIN" }, application: { id: row.id, appliedAmount: row.appliedAmount, productId: row.productId, branchId: row.branchId, riskGradeRank: null, inputStaffIds: [] } }))
    expect(gate.kind).toBe("respond")
    await gradeWritten("bp-grade", 4)
    expect(await approveAs("la1", "bp-grade")).toMatchObject({ status: 200, body: { approvalRecorded: true, level: 1, requiredLevels: 3 } })
    expect(await statusOf("bp-grade")).toBe("UNDER_REVIEW")
    const theCase = await caseOf("bp-grade")
    expect(theCase).toMatchObject({ requiredLevels: 3 })
    expect(await refusal(sql(`UPDATE "ApprovalCase" SET "requiredLevels" = 1 WHERE "id" = '${theCase.id}'`))).toContain("raised")
  })

  it("a grade written after a level was recorded raises the requirement for the levels still to come, on the record", async () => {
    await underReview("bp-regrade", { amount: 450_000 })
    expect(await approveAs("la1", "bp-regrade")).toMatchObject({ status: 200, body: { approvalRecorded: true, requiredLevels: 2 } })
    await gradeWritten("bp-regrade", 4)
    expect(await approveAs("bm", "bp-regrade")).toMatchObject({ status: 200, body: { approvalRecorded: true, level: 2, requiredLevels: 3 } })
    expect(await statusOf("bp-regrade")).toBe("UNDER_REVIEW")
    expect(await caseOf("bp-regrade")).toMatchObject({ requiredLevels: 3, matchedRuleIds: expect.arrayContaining(["risky"]) })
    const raised = await db.auditLog.findFirstOrThrow({ where: { tenantId: ids.tenant, action: "APPROVAL_REQUIREMENT_RAISED", entityId: "bp-regrade" } })
    expect(raised.newValue).toMatchObject({ previousRequiredLevels: 2, requiredLevels: 3 })
  })

  it("the engine, through the real approval path, cannot approve an application whose grade needs staff (the grade is the verdict's, not yet stored)", async () => {
    await underReview("bp-engine", { amount: 150_000 })
    const sysId = `bp-sys-${t}`
    await db.user.create({ data: { id: sysId, tenantId: ids.tenant, email: `${sysId}@system.invalid`, password: "!", role: "LOAN_ADMIN", active: false, isSystem: true } })
    const row = await db.loanApplication.findUniqueOrThrow({ where: { id: "bp-engine" } })
    const form = new FormData()
    form.set("action", "approve")
    form.set("repaymentMethod", "EFT")
    form.set("reason", "Approved automatically (test:v1)")
    const res = await inTenant(() => decideApplication({
      tenant: { id: ids.tenant }, user: { id: sysId, email: `${sysId}@system.invalid`, role: "LOAN_ADMIN" }, id: "bp-engine", formData: form,
      automation: { ruleVersion: "test:v1", ruleSetVersionId: "v", reasonCodes: [], riskGrade: "D", riskGradeRank: 4, bureauCheckId: null, exactInputs: {}, expectedUpdatedAt: row.updatedAt, inTransaction: async () => undefined },
    }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ approvalMatrix: "AUTOMATION_NOT_PERMITTED" })
    expect(await statusOf("bp-engine")).toBe("UNDER_REVIEW")
  })

  it("with a matrix in force, a plain status write cannot approve an application that has no completed chain", async () => {
    await underReview("bp-nocase", { amount: 900_000 })
    expect(await db.approvalCase.count({ where: { applicationId: "bp-nocase" } })).toBe(0)
    const write = () => inTenant(() => app().loanApplication.update({ where: { id: "bp-nocase" }, data: { status: "APPROVED", approvedById: ids.la1, approvedAt: new Date(), approvedAmount: 900_000, approvedTermDays: 180, repaymentMethod: "EFT" } }))
    expect(await refusal(write())).toContain("pproval matrix")
    expect(await statusOf("bp-nocase")).toBe("UNDER_REVIEW")
  })

  it("two administrators cannot approve a matrix that weakens the lender's approvals: any change to the matrix needs a SUPER_ADMIN", async () => {
    const weaker = { ...M, rules: [{ id: "big", name: "Big", when: { amountMinCents: 2_000_000_000 }, requiredLevels: 3 }] }
    const draft = await createDraft({ tenantId: ids.tenant, actor: as.maker, kind: MATRIX_KIND, title: "Tidy", payload: weaker })
    await submit({ tenantId: ids.tenant, actor: as.maker, id: draft.id })
    await expect(approve({ tenantId: ids.tenant, actor: as.ad, id: draft.id })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await underReview("bp-weak", { amount: 750_000 })
    expect(await approveAs("la1", "bp-weak")).toMatchObject({ status: 200, body: { approvalRecorded: true, requiredLevels: 3 } })
  })
})
