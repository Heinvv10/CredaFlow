/** Delegated authority (approval matrix, real Postgres): what a delegation reaches, and what the database holds of it. See approval.integration.test.ts. */

import { expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { grantDelegation, revokeDelegation } from "./delegations"
import { A, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, MATRIX, refusal, registerApprovalFixture, sql, stepsOf, suite, underReview } from "./approval.integration-fixture"

suite("approval matrix: delegated authority (real Postgres)", () => {
  registerApprovalFixture()

  it("setup: the matrix is approved through maker-checker", async () => {
    await approveMatrix(MATRIX)
  })

  it("a delegation gives its level up to its amount until it ends; the step says it was delegated; revoking ends it", async () => {
    const day = 86_400_000
    const delegation = (over: Record<string, unknown> = {}) => ({ delegateId: ids.la2, level: 2, maxAmountCents: 600_000, validFrom: new Date(Date.now() - 60_000), validTo: new Date(Date.now() + 7 * day), reason: "Branch manager away on leave this week", ...over })
    // Authority cannot be passed on from a role that lacks it.
    await expect(grantDelegation({ tenantId: ids.tenant, actor: as.la1, delegation: delegation() })).rejects.toMatchObject({ code: "INVALID" })
    const granted = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.bm, delegation: delegation() }))
    await underReview(A("ap-delegated"), { amount: 500_000 })
    expect((await approveAs("la1", A("ap-delegated"))).status).toBe(200)
    const done = await approveAs("la2", A("ap-delegated"))
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(await stepsOf(A("ap-delegated"))).toMatchObject([{ level: 1 }, { level: 2, approverId: ids.la2, via: "DELEGATION", delegationId: granted.id }])
    // Above the delegated amount it does not reach.
    await underReview(A("ap-over-limit"), { amount: 650_000 })
    expect((await approveAs("la1", A("ap-over-limit"))).status).toBe(200)
    expect(await approveAs("la2", A("ap-over-limit"))).toMatchObject({ status: 403, body: { approvalMatrix: "LEVEL_AUTHORITY_REQUIRED" } })
    // Revoked: no more.
    await underReview(A("ap-revoked"), { amount: 500_000 })
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: granted.id }))
    expect((await approveAs("la1", A("ap-revoked"))).status).toBe(200)
    expect(await approveAs("la2", A("ap-revoked"))).toMatchObject({ status: 403, body: { approvalMatrix: "LEVEL_AUTHORITY_REQUIRED" } })
    await expect(revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: granted.id })).rejects.toMatchObject({ code: "ALREADY_ENDED" })
  })

  it("a delegation recorded on someone else's behalf cannot name the recorder as delegate or exceed the recorder's level, and tells the delegator", async () => {
    const day = 86_400_000
    const base = { level: 2, maxAmountCents: 600_000, validFrom: new Date(Date.now() - 60_000), validTo: new Date(Date.now() + 7 * day), reason: "Recorded for the branch manager on leave" }
    // The administrator names themselves: refused (they would grant themselves the branch manager's authority).
    await expect(grantDelegation({ tenantId: ids.tenant, actor: as.ad, delegation: { ...base, delegatorId: ids.bm, delegateId: ids.ad } })).rejects.toMatchObject({ code: "INVALID" })
    // A loan admin acting for the branch manager is not allowed on behalf at all.
    await expect(grantDelegation({ tenantId: ids.tenant, actor: as.la1, delegation: { ...base, delegatorId: ids.bm, delegateId: ids.la2 } })).rejects.toMatchObject({ code: "FORBIDDEN" })
    // An administrator naming someone else is fine, is audited as on behalf, and the delegator is told.
    const made = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.ad, delegation: { ...base, delegatorId: ids.bm, delegateId: ids.la2 } }))
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: ids.tenant, action: "APPROVAL_DELEGATION_GRANTED", entityId: made.id } })
    expect(audit.newValue).toMatchObject({ onBehalfOf: ids.bm, recordedBy: ids.ad, delegatorId: ids.bm, delegateId: ids.la2 })
    expect(await db.notification.count({ where: { tenantId: ids.tenant, userId: ids.bm, type: "APPROVAL_DELEGATED_ON_YOUR_BEHALF" } })).toBe(1)
    // The amount is told in the lender's currency, not as a bare number.
    const told = await db.notification.findFirstOrThrow({ where: { tenantId: ids.tenant, userId: ids.bm, type: "APPROVAL_DELEGATED_ON_YOUR_BEHALF" } })
    expect(told.body).toContain("R 6,000.00")
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: made.id }))
  })

  it("the database holds a delegation's shape, and it is never edited or deleted", async () => {
    const row = await db.approvalDelegation.findFirstOrThrow({ where: { tenantId: ids.tenant } })
    const insert = (cols: string) => sql(`INSERT INTO "ApprovalDelegation" ("id","tenantId","delegatorId","delegateId","level","maxAmountCents","validFrom","validTo","reason","createdById") VALUES ('d-${randomUUID()}','${ids.tenant}',${cols})`)
    const ok = (over: Record<string, string> = {}) => { const v = { del: `'${ids.bm}'`, dg: `'${ids.la2}'`, lvl: "2", amt: "100", from: "now()", to: "now() + interval '5 days'", reason: "'a proper reason here'", ...over }; return `${v.del},${v.dg},${v.lvl},${v.amt},${v.from},${v.to},${v.reason},'${ids.bm}'` }
    await insert(ok())
    expect(await refusal(insert(ok({ to: "now() + interval '91 days'" })))).toContain("ApprovalDelegation_shape")
    expect(await refusal(insert(ok({ dg: `'${ids.bm}'` })))).toMatch(/ApprovalDelegation_shape|two active staff members/)
    expect(await refusal(insert(ok({ amt: "0" })))).toContain("ApprovalDelegation_shape")
    expect(await refusal(insert(ok({ reason: "'short'" })))).toContain("ApprovalDelegation_shape")
    expect(await refusal(sql(`UPDATE "ApprovalDelegation" SET "maxAmountCents" = 999999999 WHERE "id" = '${row.id}'`))).toContain("never edited")
    expect(await refusal(sql(`DELETE FROM "ApprovalDelegation" WHERE "id" = '${row.id}'`))).toContain("never goes away")
  })
  it("the database refuses a delegated step that names no delegation, someone else's, one that is revoked, or one that does not reach the amount", async () => {
    const day = 86_400_000
    const grant = (maxAmountCents: number) => inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.bm, delegation: { delegateId: ids.la2, level: 2, maxAmountCents, validFrom: new Date(), validTo: new Date(Date.now() + 7 * day), reason: "Covering the branch this week" } }))
    const small = await grant(100_000)
    const big = await grant(2_000_000_000)
    await underReview(A("ap-dbdeleg"), { amount: 500_000 })
    expect((await approveAs("la1", A("ap-dbdeleg"))).status).toBe(200)
    const theCase = await caseOf(A("ap-dbdeleg"))
    const step = (approver: string, delegation: string) => sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via","delegationId") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','${A("ap-dbdeleg")}',2,'${approver}','DELEGATION','${delegation}')`)
    expect(await refusal(step(ids.la2, "no-such-delegation"))).toContain("names a delegation that exists")
    expect(await refusal(step(ids.la2, small.id))).toContain("in force and reaches this level and amount")
    expect(await refusal(step(ids.ad2, big.id))).toContain("in force and reaches this level and amount")
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: big.id }))
    expect(await refusal(step(ids.la2, big.id))).toContain("in force and reaches this level and amount")
  })
})
