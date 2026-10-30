/** The credit committee's decisions and the committee level (approval matrix, real Postgres). See approval.integration.test.ts. */

import { expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { recordCommitteeDecision } from "./committee"
import { loadApprovalProgress } from "./progress"
import { A, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, MATRIX, refusal, registerApprovalFixture, sql, statusOf, stepsOf, suite, TODAY, underReview } from "./approval.integration-fixture"

suite("approval matrix: credit committee (real Postgres)", () => {
  registerApprovalFixture()

  it("setup: the matrix is approved through maker-checker", async () => {
    await approveMatrix(MATRIX)
  })

  it("the committee's level waits for its decision: nothing, a deferral or a decline blocks; an approval with conditions lets the chain complete", async () => {
    await underReview(A("ap-big"), { amount: 800_000, inputStaff: [ids.officer] })
    expect((await approveAs("la1", A("ap-big"))).status).toBe(200)
    // Not at the committee yet: the branch manager has not approved.
    await expect(inTenant(() => recordCommitteeDecision({ tenantId: ids.tenant, actor: as.ad, applicationId: A("ap-big"), decision: { decision: "APPROVED", meetingDate: TODAY, attendees: ["A. Dlamini"], conditions: [], rationale: "Too early for this one" } }))).rejects.toMatchObject({ code: "NOT_AT_COMMITTEE" })
    expect((await approveAs("bm", A("ap-big"))).status).toBe(200)
    expect(await approveAs("ad2", A("ap-big"))).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_DECISION_REQUIRED" } })
    const decide = (decision: "APPROVED" | "DECLINED" | "DEFERRED", conditions: string[] = [], actor = as.ad) =>
      inTenant(() => recordCommitteeDecision({ tenantId: ids.tenant, actor, applicationId: A("ap-big"), decision: { decision, meetingDate: TODAY, attendees: ["A. Dlamini", "B. Mokoena"], conditions, rationale: `Committee ${decision.toLowerCase()} this application` } }))
    await expect(decide("APPROVED", [], as.la2)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await decide("DEFERRED")
    expect(await approveAs("ad2", A("ap-big"))).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_DECISION_REQUIRED" } })
    await decide("DECLINED")
    expect(await approveAs("ad2", A("ap-big"))).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_DECLINED" } })
    // The administrator who recorded the decline cannot overturn it; another member of the committee, by role, can.
    await expect(decide("APPROVED", [], as.ad)).rejects.toMatchObject({ code: "OVERTURN_NEEDS_ANOTHER_RECORDER" })
    await decide("APPROVED", ["Obtain a signed employer letter before disbursement", "Insure the vehicle with the bank noted"], as.checker)
    // Whoever recorded the committee's decision cannot also give the committee level's approval: not the route, not the database.
    expect(await approveAs("checker", A("ap-big"))).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_RECORDER_CANNOT_APPROVE" } })
    const bigCase = await caseOf(A("ap-big"))
    expect(await refusal(sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${bigCase.id}','${A("ap-big")}',3,'${ids.ad}','ROLE')`))).toContain("recorded the credit committee")
    // ...and someone who approved a lower level cannot record it.
    await expect(decide("APPROVED", [], as.bm)).rejects.toMatchObject({ code: "APPROVER" })
    expect(await refusal(sql(`INSERT INTO "CreditCommitteeDecision" ("id","tenantId","caseId","applicationId","level","decision","meetingDate","conditions","rationale","recordedById") VALUES ('c-${randomUUID()}','${ids.tenant}','${bigCase.id}','${A("ap-big")}',3,'DEFERRED',now(),'[]'::jsonb,'a proper rationale here','${ids.la1}')`))).toContain("approved a level of the case")
    const final = await approveAs("ad2", A("ap-big"))
    expect(final.status, JSON.stringify(final.body)).toBe(200)
    expect(await statusOf(A("ap-big"))).toBe("APPROVED")
    expect((await stepsOf(A("ap-big")))[2]).toMatchObject({ level: 3, approverId: ids.ad2, conditions: ["Obtain a signed employer letter before disbursement", "Insure the vehicle with the bank noted"] })
    expect(await db.creditCommitteeDecision.count({ where: { tenantId: ids.tenant, applicationId: A("ap-big") } })).toBe(3)
    const progress = await inTenant(() => loadApprovalProgress({ tenantId: ids.tenant, applicationId: A("ap-big"), viewer: { id: ids.ad2, role: "ADMIN" } }))
    expect(progress.committeeDecisions.map((d) => d.decision)).toEqual(["DEFERRED", "DECLINED", "APPROVED"])
    expect(progress.levels[2]).toMatchObject({ committee: true, state: "APPROVED", conditions: expect.arrayContaining(["Obtain a signed employer letter before disbursement"]) })
    // The committee's attendees, rationale and conditions are for those who may read its pack: a credit officer sees the chain, not those.
    const officerView = await inTenant(() => loadApprovalProgress({ tenantId: ids.tenant, applicationId: A("ap-big"), viewer: { id: ids.officer, role: "CREDIT_OFFICER" } }))
    expect(officerView.committeeDecisions).toEqual([])
    expect(officerView.levels[2]).toMatchObject({ state: "APPROVED", conditions: [] })
  })

  it("the database refuses committee decisions that carry conditions on a decline, and edits of any decision", async () => {
    const row = await db.creditCommitteeDecision.findFirstOrThrow({ where: { tenantId: ids.tenant } })
    expect(await refusal(sql(`UPDATE "CreditCommitteeDecision" SET "rationale" = 'Rewritten after the fact' WHERE "id" = '${row.id}'`))).toContain("append-only")
    expect(await refusal(sql(`INSERT INTO "CreditCommitteeDecision" ("id","tenantId","caseId","applicationId","level","decision","meetingDate","conditions","rationale","recordedById") VALUES ('c-${randomUUID()}','${ids.tenant}','${row.caseId}','${A("ap-big")}',3,'DECLINED','2026-11-05','["a condition"]'::jsonb,'a proper rationale here','${ids.ad}')`))).toContain("CreditCommitteeDecision_shape")
  })
})
