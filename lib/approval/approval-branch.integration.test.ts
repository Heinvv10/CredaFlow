/** F8: a branch-scoped level through the real decide path, the matrix change route's parser, the delegation and the step trigger (real Postgres, under RLS). */
import { randomUUID } from "node:crypto"
import { expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { grantDelegation } from "./delegations"
import { loadApprovalProgress } from "./progress"
import { A, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, MATRIX, refusal, registerApprovalFixture, sql, statusOf, stepsOf, suite, t, underReview } from "./approval.integration-fixture"

const OTHER = `ap-branch-2-${t}`
const SCOPED = { ...MATRIX, levels: MATRIX.levels.map((l) => (l.level === 2 ? { ...l, branchScoped: true } : l)) }
const insertStep = (caseId: string, applicationId: string, level: number, approverId: string) =>
  sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${caseId}','${applicationId}',${level},'${approverId}','ROLE')`)

suite("approval matrix: branch-scoped authority (real Postgres)", () => {
  registerApprovalFixture()

  it("setup: the scoped matrix is approved through maker-checker; the branch manager runs another branch", async () => {
    await approveMatrix(SCOPED)
    await db.branch.create({ data: { id: OTHER, tenantId: ids.tenant, name: "Teyateyaneng", code: `C-${t}` } as never })
    await db.user.update({ where: { id: ids.bm }, data: { branchId: OTHER } })
  })

  it("a branch manager of another branch is refused the level, with its own reason, by the gate and the database; the view agrees", async () => {
    await underReview(A("away"), { amount: 500_000 })
    expect((await approveAs("la1", A("away"))).status).toBe(200)
    const refused = await approveAs("bm", A("away"))
    expect(refused).toMatchObject({ status: 403, body: { approvalMatrix: "BRANCH_AUTHORITY_REQUIRED" } })
    const view = await inTenant(() => loadApprovalProgress({ tenantId: ids.tenant, applicationId: A("away"), viewer: { id: ids.bm, role: "BRANCH_MANAGER" } }))
    expect(view.viewer).toMatchObject({ canApprove: false, reason: expect.stringContaining("branch by branch") })
    const theCase = await caseOf(A("away"))
    expect(await refusal(insertStep(theCase.id, A("away"), 2, ids.bm))).toContain("held at the application's branch")
    expect(await stepsOf(A("away"))).toHaveLength(1)
  })

  it("at their own branch they approve; an ADMIN with no branch is head office and approves anywhere", async () => {
    await db.user.update({ where: { id: ids.bm }, data: { branchId: ids.branch } })
    expect((await approveAs("bm", A("away"))).status).toBe(200)
    expect(await statusOf(A("away"))).toBe("APPROVED")
    await underReview(A("office"), { amount: 500_000 })
    expect((await approveAs("la1", A("office"))).status).toBe(200)
    expect((await approveAs("ad", A("office"))).status).toBe(200)
    expect(await statusOf(A("office"))).toBe("APPROVED")
    await db.user.update({ where: { id: ids.bm }, data: { branchId: OTHER } })
  })

  it("a branch manager with no branch holds a scoped level nowhere: gate and database, also on an application with no branch", async () => {
    await db.user.update({ where: { id: ids.bm }, data: { branchId: null } })
    await underReview(A("unassigned"), { amount: 500_000 })
    expect((await approveAs("la1", A("unassigned"))).status).toBe(200)
    expect(await approveAs("bm", A("unassigned"))).toMatchObject({ status: 403, body: { approvalMatrix: "BRANCH_AUTHORITY_REQUIRED" } })
    const theCase = await caseOf(A("unassigned"))
    expect(await refusal(insertStep(theCase.id, A("unassigned"), 2, ids.bm))).toContain("held at the application's branch")
    await db.user.update({ where: { id: ids.bm }, data: { branchId: OTHER } })
  })

  it("a level that is not scoped is unchanged: level 1 ignores the approver's branch", async () => {
    await db.user.update({ where: { id: ids.la1 }, data: { branchId: OTHER } })
    await underReview(A("open"), { amount: 500_000 })
    expect((await approveAs("la1", A("open"))).status).toBe(200)
    await db.user.update({ where: { id: ids.la1 }, data: { branchId: null } })
  })

  it("a delegation carries the delegator's branch: passed on from elsewhere it does not reach, passed on from here it does; the trigger agrees", async () => {
    const day = 86_400_000
    const delegation = (delegateId: string) => ({ delegateId, level: 2, maxAmountCents: 900_000, validFrom: new Date(Date.now() - 60_000), validTo: new Date(Date.now() + 5 * day), reason: "Cover while I am away" })
    await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.bm, delegation: delegation(ids.la2) }))
    await underReview(A("deleg"), { amount: 500_000 })
    expect((await approveAs("la1", A("deleg"))).status).toBe(200)
    expect(await approveAs("la2", A("deleg"))).toMatchObject({ status: 403, body: { approvalMatrix: "BRANCH_AUTHORITY_REQUIRED" } })
    await db.user.update({ where: { id: ids.bm }, data: { branchId: ids.branch } })
    const done = await approveAs("la2", A("deleg"))
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(await stepsOf(A("deleg"))).toMatchObject([{ level: 1 }, { level: 2, approverId: ids.la2, via: "DELEGATION" }])
  })
})
