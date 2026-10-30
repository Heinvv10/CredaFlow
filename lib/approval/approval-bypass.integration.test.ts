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
import { ApprovalFactsChangedError, assertGateFactsUnchanged, gateApproval } from "./chain"
import { recordCommitteeDecision } from "./committee"
import { grantDelegation, revokeDelegation } from "./delegations"
import { MATRIX_KIND } from "./types"
import { A, app, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, refusal, registerApprovalFixture, sql, statusOf, stepsOf, suite, t, TODAY, underReview } from "./approval.integration-fixture"

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
    await atCommittee(A("bp-decl"))
    await committee(as.checker, A("bp-decl"), "DECLINED", "Committee declined: too risky.")
    await expect(committee(as.checker, A("bp-decl"), "APPROVED", "Changed my mind alone.")).rejects.toMatchObject({ code: "OVERTURN_NEEDS_ANOTHER_RECORDER" })
    await expect(committee(as.ad, A("bp-decl"), "APPROVED", "An administrator overturns it.")).rejects.toMatchObject({ code: "FORBIDDEN" })
    // Nor a delegate of the committee's level: a decline is overturned by a member who holds the role.
    const deputy = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.checker2, delegation: { delegateId: ids.la2, level: 3, maxAmountCents: 2_000_000_000, ...window(), reason: "Deputising for the committee chair" } }))
    await expect(committee(as.la2, A("bp-decl"), "APPROVED", "A delegate overturns it.")).rejects.toMatchObject({ code: "FORBIDDEN" })
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.checker2, id: deputy.id }))
    expect(await db.creditCommitteeDecision.count({ where: { applicationId: A("bp-decl") } })).toBe(1)
    await committee(as.checker2, A("bp-decl"), "APPROVED", "A second member re-heard it.")
    expect(await db.creditCommitteeDecision.count({ where: { applicationId: A("bp-decl") } })).toBe(2)
  })

  it("the database refuses the same overturn written directly", async () => {
    await atCommittee(A("bp-decl2"))
    await committee(as.checker, A("bp-decl2"), "DECLINED", "Committee declined: too risky.")
    const theCase = await caseOf(A("bp-decl2"))
    const insertFor = (by: string) => sql(`INSERT INTO "CreditCommitteeDecision" ("id","tenantId","caseId","applicationId","level","decision","meetingDate","conditions","rationale","recordedById") VALUES ('c-${randomUUID()}','${ids.tenant}','${theCase.id}','${A("bp-decl2")}',3,'APPROVED',now(),'[]'::jsonb,'a proper rationale here','${by}')`)
    expect(await refusal(insertFor(ids.checker))).toContain("overturn")
    await insertFor(ids.checker2)
  })

  it("a delegate cannot act on the authority of someone who already approved the application, or who made it", async () => {
    const granted = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.bm, delegation: { delegateId: ids.la2, level: 2, maxAmountCents: 2_000_000_000, ...window(), reason: "Covering for my leave" } }))
    await underReview(A("bp-deleg"), { amount: 500_000 })
    expect((await approveAs("bm", A("bp-deleg"))).status).toBe(200)
    expect(await approveAs("la2", A("bp-deleg"))).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    expect(await statusOf(A("bp-deleg"))).toBe("UNDER_REVIEW")
    expect(await stepsOf(A("bp-deleg"))).toHaveLength(1)
    // The maker's own authority, through his delegate.
    await underReview(A("bp-makerdel"), { amount: 500_000, inputStaff: [ids.bm] })
    expect((await approveAs("la1", A("bp-makerdel"))).status).toBe(200)
    expect(await approveAs("la2", A("bp-makerdel"))).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    expect(await statusOf(A("bp-makerdel"))).toBe("UNDER_REVIEW")
    // The database refuses it too: a step on a delegation whose delegator already has a step on the case, and a delegation that is no delegation.
    const theCase = await caseOf(A("bp-deleg"))
    const step = (approver: string, delegation: string) => sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via","delegationId") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','${A("bp-deleg")}',2,'${approver}','DELEGATION','${delegation}')`)
    expect(await refusal(step(ids.la2, granted.id))).toContain("one seat")
    expect(await refusal(step(ids.la2, "no-such-delegation"))).toMatch(/delegation|foreign key/i)
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: granted.id }))
  })

  it("a delegator whose delegate already approved on their authority cannot approve as well", async () => {
    const granted = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.bm, delegation: { delegateId: ids.la2, level: 2, maxAmountCents: 2_000_000_000, ...window(), reason: "Covering for my leave" } }))
    await underReview(A("bp-reverse"), { amount: 800_000 })
    expect((await approveAs("la1", A("bp-reverse"))).status).toBe(200)
    expect((await approveAs("la2", A("bp-reverse"))).status).toBe(200)
    expect((await stepsOf(A("bp-reverse")))[1]).toMatchObject({ level: 2, approverId: ids.la2, via: "DELEGATION", delegationId: granted.id })
    expect(await approveAs("bm", A("bp-reverse"))).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    const theCase = await caseOf(A("bp-reverse"))
    expect(await refusal(sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','${A("bp-reverse")}',3,'${ids.bm}','ROLE')`))).toContain("one seat")
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: granted.id }))
  })

  it("one delegator cannot act twice through two delegates, at two levels", async () => {
    const grant = (delegateId: string) => inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.bm, delegation: { delegateId, level: 2, maxAmountCents: 2_000_000_000, ...window(), reason: "Covering for my leave" } }))
    const toA = await grant(ids.la2)
    const toB = await grant(ids.la1)
    await underReview(A("bp-twice"), { amount: 500_000 })
    expect((await approveAs("la2", A("bp-twice"))).status).toBe(200)
    expect((await stepsOf(A("bp-twice")))[0]).toMatchObject({ level: 1, approverId: ids.la2, via: "DELEGATION", delegationId: toA.id })
    expect(await approveAs("la1", A("bp-twice"))).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    expect(await statusOf(A("bp-twice"))).toBe("UNDER_REVIEW")
    const theCase = await caseOf(A("bp-twice"))
    expect(await refusal(sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via","delegationId") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','${A("bp-twice")}',2,'${ids.la1}','DELEGATION','${toB.id}')`))).toContain("one seat")
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: toA.id }))
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: toB.id }))
  })

  it("the facts the gate decided on are read again in the approval's own transaction, and a change refuses it", async () => {
    await underReview(A("bp-facts"), { amount: 300_000 })
    const row = await db.loanApplication.findUniqueOrThrow({ where: { id: A("bp-facts") } })
    const seen = { id: row.id, appliedAmount: row.appliedAmount, productId: row.productId, branchId: row.branchId, riskGradeRank: row.riskGradeRank, inputStaffIds: row.inputStaffIds }
    const check = () => inTenant(() => app().$transaction((tx) => assertGateFactsUnchanged(tx, ids.tenant, seen)))
    await expect(check()).resolves.toBeUndefined()
    await db.loanApplication.update({ where: { id: A("bp-facts") }, data: { appliedAmount: 900_000 } })
    await expect(check()).rejects.toBeInstanceOf(ApprovalFactsChangedError)
    await db.loanApplication.update({ where: { id: A("bp-facts") }, data: { appliedAmount: 300_000, inputStaffIds: [ids.bm] } })
    await expect(check()).rejects.toBeInstanceOf(ApprovalFactsChangedError)
  })

  it("the requirement follows the facts: an engine attempt before the grade is written freezes nothing, and a later grade raises it, never lowers it", async () => {
    await underReview(A("bp-grade"), { amount: 300_000 })
    const row = await db.loanApplication.findUniqueOrThrow({ where: { id: A("bp-grade") } })
    const gate = await inTenant(() => gateApproval({ tenantId: ids.tenant, automated: true, user: { id: ids.la1, email: "sys@x.invalid", role: "LOAN_ADMIN" }, application: { id: row.id, appliedAmount: row.appliedAmount, productId: row.productId, branchId: row.branchId, riskGradeRank: null, inputStaffIds: [] } }))
    expect(gate.kind).toBe("respond")
    await gradeWritten(A("bp-grade"), 4)
    expect(await approveAs("la1", A("bp-grade"))).toMatchObject({ status: 200, body: { approvalRecorded: true, level: 1, requiredLevels: 3 } })
    expect(await statusOf(A("bp-grade"))).toBe("UNDER_REVIEW")
    const theCase = await caseOf(A("bp-grade"))
    expect(theCase).toMatchObject({ requiredLevels: 3 })
    expect(await refusal(sql(`UPDATE "ApprovalCase" SET "requiredLevels" = 1 WHERE "id" = '${theCase.id}'`))).toContain("raised")
  })

  it("a grade written after a level was recorded raises the requirement for the levels still to come, on the record", async () => {
    await underReview(A("bp-regrade"), { amount: 450_000 })
    expect(await approveAs("la1", A("bp-regrade"))).toMatchObject({ status: 200, body: { approvalRecorded: true, requiredLevels: 2 } })
    await gradeWritten(A("bp-regrade"), 4)
    expect(await approveAs("bm", A("bp-regrade"))).toMatchObject({ status: 200, body: { approvalRecorded: true, level: 2, requiredLevels: 3 } })
    expect(await statusOf(A("bp-regrade"))).toBe("UNDER_REVIEW")
    expect(await caseOf(A("bp-regrade"))).toMatchObject({ requiredLevels: 3, matchedRuleIds: expect.arrayContaining(["risky"]) })
    const raised = await db.auditLog.findFirstOrThrow({ where: { tenantId: ids.tenant, action: "APPROVAL_REQUIREMENT_RAISED", entityId: A("bp-regrade") } })
    expect(raised.newValue).toMatchObject({ previousRequiredLevels: 2, requiredLevels: 3 })
  })

  it("the engine, through the real approval path, cannot approve an application whose grade needs staff (the grade is the verdict's, not yet stored)", async () => {
    await underReview(A("bp-engine"), { amount: 150_000 })
    const sysId = `bp-sys-${t}`
    await db.user.create({ data: { id: sysId, tenantId: ids.tenant, email: `${sysId}@system.invalid`, password: "!", role: "LOAN_ADMIN", active: false, isSystem: true } })
    const row = await db.loanApplication.findUniqueOrThrow({ where: { id: A("bp-engine") } })
    const form = new FormData()
    form.set("action", "approve")
    form.set("repaymentMethod", "EFT")
    form.set("reason", "Approved automatically (test:v1)")
    const res = await inTenant(() => decideApplication({
      tenant: { id: ids.tenant }, user: { id: sysId, email: `${sysId}@system.invalid`, role: "LOAN_ADMIN" }, id: A("bp-engine"), formData: form,
      automation: { ruleVersion: "test:v1", ruleSetVersionId: "v", reasonCodes: [], riskGrade: "D", riskGradeRank: 4, bureauCheckId: null, exactInputs: {}, expectedUpdatedAt: row.updatedAt, inTransaction: async () => undefined },
    }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ approvalMatrix: "AUTOMATION_NOT_PERMITTED" })
    expect(await statusOf(A("bp-engine"))).toBe("UNDER_REVIEW")
  })

  it("with a matrix in force, a plain status write cannot approve an application that has no completed chain", async () => {
    await underReview(A("bp-nocase"), { amount: 900_000 })
    expect(await db.approvalCase.count({ where: { applicationId: A("bp-nocase") } })).toBe(0)
    const write = () => inTenant(() => app().loanApplication.update({ where: { id: A("bp-nocase") }, data: { status: "APPROVED", approvedById: ids.la1, approvedAt: new Date(), approvedAmount: 900_000, approvedTermDays: 180, repaymentMethod: "EFT" } }))
    expect(await refusal(write())).toContain("pproval matrix")
    expect(await statusOf(A("bp-nocase"))).toBe("UNDER_REVIEW")
  })

  it("two administrators cannot approve a matrix that weakens the lender's approvals: any change to the matrix needs a SUPER_ADMIN", async () => {
    const weaker = { ...M, rules: [{ id: "big", name: "Big", when: { amountMinCents: 2_000_000_000 }, requiredLevels: 3 }] }
    const draft = await createDraft({ tenantId: ids.tenant, actor: as.maker, kind: MATRIX_KIND, title: "Tidy", payload: weaker })
    await submit({ tenantId: ids.tenant, actor: as.maker, id: draft.id })
    await expect(approve({ tenantId: ids.tenant, actor: as.ad, id: draft.id })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await underReview(A("bp-weak"), { amount: 750_000 })
    expect(await approveAs("la1", A("bp-weak"))).toMatchObject({ status: 200, body: { approvalRecorded: true, requiredLevels: 3 } })
  })
})
