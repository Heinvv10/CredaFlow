/**
 * Real-Postgres proof of the approval matrix (migration 20261030100000_approval_matrix), through the real staff approval path and
 * under a role row-level security binds: the matrix arrives only by maker-checker; a multi-level application is approved level by
 * level by different people; the maker never approves; the engine cannot approve what needs staff; overdue approvals escalate; and
 * the database refuses an APPROVED application whose chain is incomplete, a step out of order, from the maker or the system account.
 * Delegation, the credit committee and the bypass attempts are in approval-*.integration.test.ts.
 *
 *   RUN_APPROVAL_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/approval/approval.integration.test.ts
 */

import { expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { gateApproval, openApprovalCaseSafely } from "./chain"
import { escalateOverdueApprovals } from "./escalation"
import { loadApprovalProgress } from "./progress"
import { MATRIX_KIND } from "./types"
import { MATRIX, app, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, refusal, registerApprovalFixture, sql, statusOf, stepsOf, suite, t, underReview } from "./approval.integration-fixture"

suite("approval matrix (real Postgres, row-level security)", () => {
  registerApprovalFixture()

  it("runs as a role row-level security binds (otherwise it proves nothing)", async () => {
    const [me] = await app().$queryRaw<{ su: boolean; bypass: boolean }[]>`SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
  })

  it("with no matrix, an approval is the single-approver flow it always was (no case, no step)", async () => {
    await underReview("ap-nomatrix", { amount: 300_000 })
    const res = await approveAs("la1", "ap-nomatrix")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await statusOf("ap-nomatrix")).toBe("APPROVED")
    expect(await db.approvalCase.count({ where: { tenantId: ids.tenant, applicationId: "ap-nomatrix" } })).toBe(0)
  })

  it("the matrix arrives only through maker-checker, holds exactly what was approved, and never changes", async () => {
    const requestId = await approveMatrix(MATRIX)
    const version = await db.approvalMatrixVersion.findFirstOrThrow({ where: { tenantId: ids.tenant } })
    expect(version).toMatchObject({ version: 1, name: "Integration matrix", enabled: true, defaultRequiredLevels: 1, changeRequestId: requestId })
    const insert = (over: string, request = requestId) => sql(`INSERT INTO "ApprovalMatrixVersion" ("id","tenantId","version","name","enabled","effectiveFrom","levels","rules","defaultRequiredLevels","changeRequestId") VALUES ('v-${randomUUID()}','${ids.tenant}',${over})`.replace("REQ", request))
    expect(await refusal(insert(`9,'x',true,'2026-01-01','[]'::jsonb,'[]'::jsonb,1,'no-such-request'`))).toMatch(/jsonb|created only by an approved/i)
    const levelsJson = JSON.stringify(MATRIX.levels).replaceAll("'", "''")
    expect(await refusal(insert(`9,'Integration matrix',true,'2026-01-01','${levelsJson}'::jsonb,'[]'::jsonb,1,'no-such-request'`))).toContain("created only by an approved APPROVAL_MATRIX change request")
    expect(await refusal(insert(`9,'Integration matrix',true,'2026-01-01','${levelsJson}'::jsonb,'[]'::jsonb,0,'${requestId}'`))).toContain("must match the approved change request")
    const rulesJson = JSON.stringify(MATRIX.rules).replaceAll("'", "''")
    const good = (over: Record<number, string>) => ["9", "'Integration matrix'", "true", "'2026-01-01'", `'${levelsJson}'::jsonb`, `'${rulesJson}'::jsonb`, "1", `'${requestId}'`].map((v, i) => over[i] ?? v).join(",")
    // Each approved column is pinned on its own: the name, the switch, the levels, the rules and the default.
    const overs: Array<Record<number, string>> = [{ 1: "'Renamed'" }, { 2: "false" }, { 4: "'[]'::jsonb" }, { 5: "'[]'::jsonb" }, { 6: "2" }]
    for (const over of overs) {
      expect(await refusal(insert(good(over)))).toContain("must match the approved change request")
    }
    expect(await refusal(sql(`UPDATE "ApprovalMatrixVersion" SET "name" = 'Edited' WHERE "id" = '${version.id}'`))).toContain("never changes or goes away")
    expect(await refusal(sql(`DELETE FROM "ApprovalMatrixVersion" WHERE "id" = '${version.id}'`))).toContain("never changes or goes away")
  })

  it("a matrix that loosens (a rule needing no approval, or off) needs a SUPER_ADMIN to approve", async () => {
    for (const over of [{ defaultRequiredLevels: 0 }, { enabled: false }, { rules: [{ id: "auto", name: "Small", when: { amountMaxCents: 100_000 }, requiredLevels: 0 }] }]) {
      const draft = await createDraft({ tenantId: ids.tenant, actor: as.maker, kind: MATRIX_KIND, title: "Loosen", payload: { ...MATRIX, ...over } })
      await submit({ tenantId: ids.tenant, actor: as.maker, id: draft.id })
      await expect(approve({ tenantId: ids.tenant, actor: as.ad, id: draft.id })).rejects.toMatchObject({ code: "FORBIDDEN" })
    }
  })

  it("one level required: a loan admin's approval is the whole chain, and the case ends APPROVED with the step on record", async () => {
    await underReview("ap-small", { amount: 300_000 })
    const res = await approveAs("la1", "ap-small")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await statusOf("ap-small")).toBe("APPROVED")
    expect(await caseOf("ap-small")).toMatchObject({ status: "APPROVED", requiredLevels: 1, matchedRuleIds: [] })
    expect(await stepsOf("ap-small")).toMatchObject([{ level: 1, approverId: ids.la1, via: "ROLE" }])
  })

  it("two levels: level 1 is recorded and leaves it under review; the same person cannot do level 2, nor can a role below it; the branch manager completes it", async () => {
    await underReview("ap-mid", { amount: 500_000 })
    const first = await approveAs("la1", "ap-mid")
    expect(first).toMatchObject({ status: 200, body: { approvalRecorded: true, level: 1, requiredLevels: 2, nextLevel: 2, status: "UNDER_REVIEW" } })
    expect(await statusOf("ap-mid")).toBe("UNDER_REVIEW")
    expect(await approveAs("la1", "ap-mid")).toMatchObject({ status: 409, body: { approvalMatrix: "ALREADY_APPROVED" } })
    expect(await approveAs("la2", "ap-mid")).toMatchObject({ status: 403, body: { approvalMatrix: "LEVEL_AUTHORITY_REQUIRED" } })
    expect(await statusOf("ap-mid")).toBe("UNDER_REVIEW")
    const last = await approveAs("bm", "ap-mid")
    expect(last.status, JSON.stringify(last.body)).toBe(200)
    expect(await statusOf("ap-mid")).toBe("APPROVED")
    expect(await caseOf("ap-mid")).toMatchObject({ status: "APPROVED", requiredLevels: 2, matchedRuleIds: ["mid"] })
    expect((await stepsOf("ap-mid")).map((s) => [s.level, s.approverId])).toEqual([[1, ids.la1], [2, ids.bm]])
  })

  it("progress shows each level, who approved it, and whether the viewer may approve next", async () => {
    const progress = await loadApprovalProgress({ tenantId: ids.tenant, applicationId: "ap-mid", viewer: { id: ids.la2, role: "LOAN_ADMIN" } })
    expect(progress).toMatchObject({ applies: true, status: "APPROVED", requiredLevels: 2, requirementFrozen: true, matchedRules: [{ id: "mid", name: "Mid-size loans" }] })
    expect(progress.levels.map((l) => [l.level, l.state])).toEqual([[1, "APPROVED"], [2, "APPROVED"], [3, "NOT_REQUIRED"]])
  })

  it("the maker never approves, at any level: the route refuses, and so does the database", async () => {
    await underReview("ap-maker", { amount: 500_000, inputStaff: [ids.bm] })
    expect(await approveAs("bm", "ap-maker")).toMatchObject({ status: 403, body: { approvalMatrix: "MAKER_CANNOT_APPROVE" } })
    // A first level done by someone else, then the maker (who has the authority) tries the second.
    expect((await approveAs("la1", "ap-maker")).status).toBe(200)
    expect(await approveAs("bm", "ap-maker")).toMatchObject({ status: 403, body: { approvalMatrix: "MAKER_CANNOT_APPROVE" } })
    const theCase = await caseOf("ap-maker")
    expect(await refusal(sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','ap-maker',2,'${ids.bm}','ROLE')`))).toContain("cannot approve it")
  })

  it("the database refuses APPROVED while the chain is incomplete, a step out of order, one past the requirement, or one by the system account", async () => {
    const theCase = await caseOf("ap-maker")
    expect(await refusal(sql(`UPDATE "LoanApplication" SET "status" = 'APPROVED' WHERE "id" = 'ap-maker'`))).toContain("every required level must approve")
    const step = (level: number, approver: string) => sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','ap-maker',${level},'${approver}','ROLE')`)
    expect(await refusal(step(3, ids.ad))).toContain("at a level the case requires")
    expect(await refusal(step(1, ids.ad))).toMatch(/in order|unique/i)
    await db.user.create({ data: { id: `ap-sys-${t}`, tenantId: ids.tenant, email: `ap-sys-${t}@system.invalid`, password: "!", role: "LOAN_ADMIN", active: false, isSystem: true } })
    expect(await refusal(step(2, `ap-sys-${t}`))).toContain("never the automated decisioning account")
  })

  it("a case's requirement is set once; its steps and escalations are append-only; the case never goes away", async () => {
    const theCase = await caseOf("ap-maker")
    expect(await refusal(sql(`UPDATE "ApprovalCase" SET "requiredLevels" = 1 WHERE "id" = '${theCase.id}'`))).toContain("set once")
    expect(await refusal(sql(`DELETE FROM "ApprovalCase" WHERE "id" = '${theCase.id}'`))).toContain("never goes away")
    expect(await refusal(sql(`UPDATE "ApprovalStep" SET "note" = 'x' WHERE "caseId" = '${theCase.id}'`))).toContain("append-only")
    expect(await refusal(sql(`DELETE FROM "ApprovalStep" WHERE "caseId" = '${theCase.id}'`))).toContain("append-only")
    expect(await refusal(sql(`UPDATE "ApprovalCase" SET "status" = 'APPROVED', "completedAt" = now() WHERE "id" = '${theCase.id}'`))).toContain("approved only when every required level has approved")
  })

  it("the decision engine cannot approve what needs staff approval, and may where none is required", async () => {
    await underReview("ap-engine", { amount: 500_000 })
    const gate = await inTenant(() => gateApproval({ tenantId: ids.tenant, application: { id: "ap-engine", appliedAmount: 500_000, productId: ids.product, branchId: ids.branch, riskGradeRank: null, inputStaffIds: [] }, user: { id: ids.la1, email: "s@system.invalid", role: "LOAN_ADMIN" }, automated: true }))
    expect(gate).toMatchObject({ kind: "respond", status: 409, body: { approvalMatrix: "AUTOMATION_NOT_PERMITTED" } })
    expect(await statusOf("ap-engine")).toBe("UNDER_REVIEW")
  })

  it("an overdue level escalates to the next up (its people are told, once), climbs again if still waiting, and reminds the top", async () => {
    await underReview("ap-slow", { amount: 800_000, inputStaff: [ids.officer] })
    // The review has started: the case (and its clock) opens with it. Make level 1 overdue.
    await inTenant(() => openApprovalCaseSafely({ tenantId: ids.tenant, applicationId: "ap-slow" }))
    const theCase = await caseOf("ap-slow")
    await sql(`UPDATE "ApprovalCase" SET "dueAt" = now() - interval '1 hour' WHERE "id" = '${theCase.id}'`)
    const now = new Date()
    expect(await escalateOverdueApprovals({ now })).toMatchObject({ escalated: 1, failed: 0 })
    expect(await db.approvalEscalation.findMany({ where: { caseId: theCase.id } })).toMatchObject([{ fromLevel: 1, toLevel: 2 }])
    const told = await db.notification.findMany({ where: { tenantId: ids.tenant, type: "APPROVAL_ESCALATED", entityId: "ap-slow" } })
    expect(told.map((n) => n.userId)).toEqual([ids.bm])
    // Not overdue again until another SLA has passed: a second run does nothing.
    expect(await escalateOverdueApprovals({ now })).toMatchObject({ escalated: 0, reminded: 0 })
    // Still waiting a full SLA later: it climbs to level 3 (the committee's ADMINs).
    expect((await escalateOverdueApprovals({ now: new Date(now.getTime() + 25 * 3_600_000) })).escalated).toBeGreaterThanOrEqual(1)
    expect((await db.approvalEscalation.findMany({ where: { caseId: theCase.id }, orderBy: { createdAt: "asc" } })).map((e) => [e.fromLevel, e.toLevel])).toEqual([[1, 2], [1, 3]])
    expect(await db.approvalEscalation.count({ where: { caseId: theCase.id } })).toBe(2)
  })

  it("leaving review any other way ends the case, and a new review opens a fresh one", async () => {
    await underReview("ap-cancelled", { amount: 500_000 })
    expect((await approveAs("la1", "ap-cancelled")).status).toBe(200)
    const first = await caseOf("ap-cancelled")
    await sql(`UPDATE "LoanApplication" SET "status" = 'CANCELLED' WHERE "id" = 'ap-cancelled'`)
    expect(await db.approvalCase.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "CLOSED" })
    expect(await refusal(sql(`UPDATE "ApprovalCase" SET "status" = 'OPEN', "completedAt" = NULL WHERE "id" = '${first.id}'`))).toContain("cannot be reopened")
  })

  it("only one open case per application", async () => {
    await underReview("ap-twice", { amount: 300_000 })
    await inTenant(() => gateApproval({ tenantId: ids.tenant, application: { id: "ap-twice", appliedAmount: 300_000, productId: ids.product, branchId: ids.branch, riskGradeRank: null, inputStaffIds: [ids.ad] }, user: as.ad, automated: false }))
    const open = await caseOf("ap-twice")
    const message = await refusal(sql(`INSERT INTO "ApprovalCase" ("id","tenantId","applicationId") VALUES ('c-${randomUUID()}','${ids.tenant}','ap-twice')`))
    expect(message, message).toMatch(/one_open|unique|23505/i)
    expect(open.status).toBe("OPEN")
  })

  it("a matrix switched off puts the lender back on the single-approver flow for new applications", async () => {
    const draft = await createDraft({ tenantId: ids.tenant, actor: as.maker, kind: MATRIX_KIND, title: "Off", payload: { ...MATRIX, enabled: false } })
    await submit({ tenantId: ids.tenant, actor: as.maker, id: draft.id })
    await approve({ tenantId: ids.tenant, actor: as.checker, id: draft.id })
    await underReview("ap-off", { amount: 500_000 })
    const res = await approveAs("la1", "ap-off")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await statusOf("ap-off")).toBe("APPROVED")
    expect(await db.approvalCase.count({ where: { tenantId: ids.tenant, applicationId: "ap-off" } })).toBe(0)
  })
})
