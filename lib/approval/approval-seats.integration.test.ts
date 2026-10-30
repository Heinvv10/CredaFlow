/**
 * One person, one seat (approval matrix, real Postgres): the people who made an application, approved a level of it or recorded its
 * committee decision, and the people whose authority any of them acted on, appear once between them. See approval.integration.test.ts.
 */
import { randomUUID } from "node:crypto"
import { expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { recordCommitteeDecision } from "./committee"
import { grantDelegation, revokeDelegation } from "./delegations"
import { A, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, refusal, registerApprovalFixture, sql, statusOf, stepsOf, suite, TODAY, underReview } from "./approval.integration-fixture"

const day = 86_400_000
const M = {
  name: "Seats matrix", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 1,
  levels: [
    { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
    { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
    { level: 3, name: "Credit committee", role: "SUPER_ADMIN", slaHours: 48, committee: true },
  ],
  rules: [{ id: "big", name: "Big", when: { amountMinCents: 700_000 }, requiredLevels: 3 }],
}
const delegate = (actor: typeof as.checker, delegateId: string, level: number) =>
  inTenant(() => grantDelegation({ tenantId: ids.tenant, actor, delegation: { delegateId, level, maxAmountCents: 2_000_000_000, validFrom: new Date(), validTo: new Date(Date.now() + 30 * day), reason: "Covering while I travel" } }))
const revoke = (actor: typeof as.checker, id: string) => inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor, id }))
const committee = (actor: typeof as.checker, applicationId: string, decision: "APPROVED" | "DECLINED") =>
  inTenant(() => recordCommitteeDecision({ tenantId: ids.tenant, actor, applicationId, decision: { decision, meetingDate: TODAY, attendees: ["Member One", "Member Two"], conditions: [], rationale: "Committee considered the pack." } }))
const stepSql = (caseId: string, applicationId: string, level: number, approver: string, delegationId: string) =>
  sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via","delegationId") VALUES ('s-${randomUUID()}','${ids.tenant}','${caseId}','${applicationId}',${level},'${approver}','DELEGATION','${delegationId}')`)

suite("approval matrix: one person, one seat (real Postgres)", () => {
  registerApprovalFixture()

  it("setup: the matrix is approved by a SUPER_ADMIN", async () => {
    await approveMatrix(M)
  })

  it("one delegator's authority fills one seat, not two: not level 2 and then level 3 through two delegates", async () => {
    const toLa2 = await delegate(as.checker2, ids.la2, 2)
    const toAd = await delegate(as.checker2, ids.ad, 3)
    await underReview(A("st-two"), { amount: 800_000 })
    expect((await approveAs("la1", A("st-two"))).status).toBe(200)
    expect((await approveAs("la2", A("st-two"))).status).toBe(200)
    await committee(as.checker, A("st-two"), "APPROVED")
    expect(await approveAs("ad", A("st-two"))).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    expect(await statusOf(A("st-two"))).toBe("UNDER_REVIEW")
    expect(await stepsOf(A("st-two"))).toHaveLength(2)
    const theCase = await caseOf(A("st-two"))
    expect(await refusal(stepSql(theCase.id, A("st-two"), 3, ids.ad, toAd.id))).toContain("one seat")
    await revoke(as.checker2, toLa2.id)
    await revoke(as.checker2, toAd.id)
  })

  it("the committee recorder's delegate cannot give the committee level's approval on the recorder's authority", async () => {
    const toAd2 = await delegate(as.checker, ids.ad2, 3)
    await underReview(A("st-recdel"), { amount: 800_000 })
    expect((await approveAs("la1", A("st-recdel"))).status).toBe(200)
    expect((await approveAs("bm", A("st-recdel"))).status).toBe(200)
    await committee(as.checker, A("st-recdel"), "APPROVED")
    expect(await approveAs("ad2", A("st-recdel"))).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    expect(await statusOf(A("st-recdel"))).toBe("UNDER_REVIEW")
    const theCase = await caseOf(A("st-recdel"))
    expect(await refusal(stepSql(theCase.id, A("st-recdel"), 3, ids.ad2, toAd2.id))).toContain("recorded the credit committee")
    await revoke(as.checker, toAd2.id)
  })

  it("a delegate of an earlier approver cannot record the committee decision on that approver's authority", async () => {
    const toAd = await delegate(as.checker2, ids.ad, 3)
    await underReview(A("st-apprdel"), { amount: 800_000 })
    expect((await approveAs("checker2", A("st-apprdel"))).status).toBe(200)
    expect((await approveAs("bm", A("st-apprdel"))).status).toBe(200)
    await expect(committee(as.ad, A("st-apprdel"), "APPROVED")).rejects.toMatchObject({ code: "APPROVER" })
    expect(await db.creditCommitteeDecision.count({ where: { applicationId: A("st-apprdel") } })).toBe(0)
    const theCase = await caseOf(A("st-apprdel"))
    const record = (by: string, delegationId: string) => sql(`INSERT INTO "CreditCommitteeDecision" ("id","tenantId","caseId","applicationId","level","decision","meetingDate","conditions","rationale","recordedById","delegationId") VALUES ('c-${randomUUID()}','${ids.tenant}','${theCase.id}','${A("st-apprdel")}',3,'APPROVED',now(),'[]'::jsonb,'a proper rationale here','${by}','${delegationId}')`)
    expect(await refusal(record(ids.ad, toAd.id))).toContain("approved a level of the case")
    await revoke(as.checker2, toAd.id)
  })

  it("a second delegate of an approver's delegator cannot record the committee decision either", async () => {
    const toLa2 = await delegate(as.checker2, ids.la2, 2)
    const toAd = await delegate(as.checker2, ids.ad, 3)
    await underReview(A("st-rec2"), { amount: 800_000 })
    expect((await approveAs("la1", A("st-rec2"))).status).toBe(200)
    expect((await approveAs("la2", A("st-rec2"))).status).toBe(200)
    await expect(committee(as.ad, A("st-rec2"), "APPROVED")).rejects.toMatchObject({ code: "APPROVER" })
    expect(await db.creditCommitteeDecision.count({ where: { applicationId: A("st-rec2") } })).toBe(0)
    await revoke(as.checker2, toLa2.id)
    await revoke(as.checker2, toAd.id)
  })

  it("a delegate who records the committee decision uses a delegation of someone who has not acted, and the decision says so", async () => {
    const toAd = await delegate(as.checker, ids.ad, 3)
    await underReview(A("st-ok"), { amount: 800_000 })
    expect((await approveAs("la1", A("st-ok"))).status).toBe(200)
    expect((await approveAs("bm", A("st-ok"))).status).toBe(200)
    const made = await committee(as.ad, A("st-ok"), "APPROVED")
    expect(made).toMatchObject({ recordedById: ids.ad, delegationId: toAd.id })
    // The recorder's delegator has now acted too: the delegator may not give the committee level's approval.
    expect(await approveAs("checker", A("st-ok"))).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_RECORDER_CANNOT_APPROVE" } })
    // And the database refuses the same step written directly: the delegator behind the recorder is seated as the recorder.
    const theCase = await caseOf(A("st-ok"))
    expect(await refusal(sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','${A("st-ok")}',3,'${ids.checker}','ROLE')`))).toContain("recorded the credit committee")
    expect((await approveAs("checker2", A("st-ok"))).status).toBe(200)
    expect(await statusOf(A("st-ok"))).toBe("APPROVED")
    await revoke(as.checker, toAd.id)
  })
})
