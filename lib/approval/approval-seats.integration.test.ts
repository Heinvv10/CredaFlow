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
import { TODAY, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, refusal, registerApprovalFixture, sql, statusOf, stepsOf, suite, underReview } from "./approval.integration-fixture"

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
    await underReview("st-two", { amount: 800_000 })
    expect((await approveAs("la1", "st-two")).status).toBe(200)
    expect((await approveAs("la2", "st-two")).status).toBe(200)
    await committee(as.checker, "st-two", "APPROVED")
    expect(await approveAs("ad", "st-two")).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    expect(await statusOf("st-two")).toBe("UNDER_REVIEW")
    expect(await stepsOf("st-two")).toHaveLength(2)
    const theCase = await caseOf("st-two")
    expect(await refusal(stepSql(theCase.id, "st-two", 3, ids.ad, toAd.id))).toContain("one seat")
    await revoke(as.checker2, toLa2.id)
    await revoke(as.checker2, toAd.id)
  })

  it("the committee recorder's delegate cannot give the committee level's approval on the recorder's authority", async () => {
    const toAd2 = await delegate(as.checker, ids.ad2, 3)
    await underReview("st-recdel", { amount: 800_000 })
    expect((await approveAs("la1", "st-recdel")).status).toBe(200)
    expect((await approveAs("bm", "st-recdel")).status).toBe(200)
    await committee(as.checker, "st-recdel", "APPROVED")
    expect(await approveAs("ad2", "st-recdel")).toMatchObject({ status: 403, body: { approvalMatrix: "DELEGATOR_ALREADY_ACTED" } })
    expect(await statusOf("st-recdel")).toBe("UNDER_REVIEW")
    const theCase = await caseOf("st-recdel")
    expect(await refusal(stepSql(theCase.id, "st-recdel", 3, ids.ad2, toAd2.id))).toContain("recorded the credit committee")
    await revoke(as.checker, toAd2.id)
  })

  it("a delegate of an earlier approver cannot record the committee decision on that approver's authority", async () => {
    const toAd = await delegate(as.checker2, ids.ad, 3)
    await underReview("st-apprdel", { amount: 800_000 })
    expect((await approveAs("checker2", "st-apprdel")).status).toBe(200)
    expect((await approveAs("bm", "st-apprdel")).status).toBe(200)
    await expect(committee(as.ad, "st-apprdel", "APPROVED")).rejects.toMatchObject({ code: "APPROVER" })
    expect(await db.creditCommitteeDecision.count({ where: { applicationId: "st-apprdel" } })).toBe(0)
    const theCase = await caseOf("st-apprdel")
    const record = (by: string, delegationId: string) => sql(`INSERT INTO "CreditCommitteeDecision" ("id","tenantId","caseId","applicationId","level","decision","meetingDate","conditions","rationale","recordedById","delegationId") VALUES ('c-${randomUUID()}','${ids.tenant}','${theCase.id}','st-apprdel',3,'APPROVED',now(),'[]'::jsonb,'a proper rationale here','${by}','${delegationId}')`)
    expect(await refusal(record(ids.ad, toAd.id))).toContain("approved a level of the case")
    await revoke(as.checker2, toAd.id)
  })

  it("a delegate who records the committee decision uses a delegation of someone who has not acted, and the decision says so", async () => {
    const toAd = await delegate(as.checker, ids.ad, 3)
    await underReview("st-ok", { amount: 800_000 })
    expect((await approveAs("la1", "st-ok")).status).toBe(200)
    expect((await approveAs("bm", "st-ok")).status).toBe(200)
    const made = await committee(as.ad, "st-ok", "APPROVED")
    expect(made).toMatchObject({ recordedById: ids.ad, delegationId: toAd.id })
    // The recorder's delegator has now acted too: the delegator may not give the committee level's approval.
    expect(await approveAs("checker", "st-ok")).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_RECORDER_CANNOT_APPROVE" } })
    expect((await approveAs("checker2", "st-ok")).status).toBe(200)
    expect(await statusOf("st-ok")).toBe("APPROVED")
    await revoke(as.checker, toAd.id)
  })
})
