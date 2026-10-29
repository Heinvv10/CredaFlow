/**
 * Real-Postgres proof of the maker-checker rules (migration
 * 20261029100000_maker_checker_decision_rules): the database refuses a
 * self-approval, a bad status shape, a skipped step, an edited payload after
 * submission and a delete; the service applies an approved payload in the
 * approval's own transaction and rolls both back together.
 *
 *   RUN_MAKER_CHECKER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/maker-checker/maker-checker.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { decisionRuleSetHandler } from "@/lib/decisioning/change-handlers"
import { RULE_SET_KIND } from "@/lib/decisioning/change-payloads"
import { asAdminChecker, asChecker, asChecker2, asMaker, asOfficer, createApplication, createLender, type Lender } from "@/lib/decisioning/decisioning.integration-fixture"
import { ChangeRequestError } from "./errors"
import { approve, createDraft, reject, submit, updateDraft, withdraw } from "./service"

const RUN = process.env.RUN_MAKER_CHECKER_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
let lender: Lender

const payload = (over: Record<string, unknown> = {}) => ({
  productId: null, name: "Baseline", effectiveFrom: "2026-01-01", challengerOnly: false,
  rules: [{ id: "judg", name: "Judgement", outcome: "KNOCK_OUT", reasonCode: "BUREAU_JUDGEMENT", declineCategory: "ADVERSE_LISTING", when: { field: "bureauJudgement", op: "eq", value: true } }],
  scorecard: null, ...over,
})
const draft = (over: Record<string, unknown> = {}) =>
  createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind: RULE_SET_KIND, title: "Add judgement knock-out", payload: payload(over) })
const sql = (text: string) => db.$executeRawUnsafe(text)
const engineConfig = (over: Record<string, unknown> = {}) => ({
  mode: "SHADOW", channels: ["STAFF"], productIds: [lender.productId], repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0,
  s71SignOff: false, automatedDeclineNotice: null, ...over,
})
async function approveChange(title: string, over: Record<string, unknown> = {}): Promise<string> {
  const d = await draft(over)
  await db.changeRequest.update({ where: { id: d.id }, data: { title } })
  await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
  await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id })
  return d.id
}
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return String(error)
  }
  throw new Error("expected the database to refuse")
}

suite("maker-checker (real Postgres)", () => {
  beforeAll(async () => { lender = await createLender(db) })
  afterAll(async () => { await db.$disconnect() })

  it("takes a change from draft to applied: the approval creates the version in the same transaction", async () => {
    const d = await draft()
    expect(d.status).toBe("DRAFT")
    const s = await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    expect(s.status).toBe("SUBMITTED")
    const a = await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id, note: "ok" })
    expect(a).toMatchObject({ status: "APPROVED", checkerId: lender.checkerId })
    expect(a.appliedAt).not.toBeNull()
    const versions = await db.decisionRuleSetVersion.findMany({ where: { tenantId: lender.tenantId, changeRequestId: d.id } })
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ scopeKey: "ALL", version: 1, name: "Baseline" })
    const audits = await db.auditLog.findMany({ where: { tenantId: lender.tenantId, entityId: d.id }, select: { action: true } })
    expect(audits.map((x) => x.action).sort()).toEqual(["CHANGE_REQUEST_APPROVED", "CHANGE_REQUEST_DRAFTED", "CHANGE_REQUEST_SUBMITTED"])
  })

  it("refuses a self-approval in the service and, if the service were bypassed, in the database", async () => {
    const d = await draft()
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    await expect(approve({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })).rejects.toMatchObject({ code: "SELF_APPROVAL" })
    await expect(reject({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id, note: "no" })).rejects.toMatchObject({ code: "SELF_APPROVAL" })
    const message = await refusal(sql(`UPDATE "ChangeRequest" SET "status"='APPROVED', "checkerId"="makerId", "decidedAt"=now(), "appliedAt"=now() WHERE "id"='${d.id}'`))
    expect(message).toContain("ChangeRequest_four_eyes")
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("SUBMITTED")
  })

  it("rolls the approval back when the handler's apply fails", async () => {
    const d = await draft({ name: "Apply fails" })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    const spy = vi.spyOn(decisionRuleSetHandler, "apply").mockRejectedValueOnce(new Error("apply failed"))
    try {
      await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id })).rejects.toThrow("apply failed")
    } finally {
      spy.mockRestore()
    }
    const after = await db.changeRequest.findUniqueOrThrow({ where: { id: d.id } })
    expect(after).toMatchObject({ status: "SUBMITTED", checkerId: null, appliedAt: null })
    const audits = await db.auditLog.findMany({ where: { tenantId: lender.tenantId, entityId: d.id }, select: { action: true } })
    expect(audits.map((x) => x.action)).not.toContain("CHANGE_REQUEST_APPROVED")
    // The request is still approvable once the fault is gone.
    expect((await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id })).status).toBe("APPROVED")
  })

  it("applies nothing and approves nothing when verification fails inside the approval transaction", async () => {
    // A rule set approved for the future, named as challenger: verification refuses it at submit, so draft it against a current one first.
    const future = await approveChange("Future set", { productId: null, name: "Future", effectiveFrom: "2099-01-01", challengerOnly: true })
    const version = await db.decisionRuleSetVersion.findFirstOrThrow({ where: { tenantId: lender.tenantId, changeRequestId: future } })
    const cfg = await createDraft({
      tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title: "Shadow with a future challenger",
      payload: engineConfig({ challengerVersionId: version.id, challengerPercent: 10 }),
    })
    await expect(submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: cfg.id })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
    // A fault appearing between submit and approval (the product is deleted) is refused inside the approval transaction.
    const gone = await db.loanProduct.create({ data: { tenantId: lender.tenantId, code: "GONE", name: "Gone", productType: "MICRO", minAmount: 1, maxAmount: 10, minTermDays: 1, maxTermDays: 30, interestRatePm: 0.05, interestModel: "FLAT" } })
    const ok = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title: "Shadow", payload: engineConfig({ productIds: [gone.id] }) })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: ok.id })
    await db.loanProduct.delete({ where: { id: gone.id } })
    await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: ok.id })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
    const after = await db.changeRequest.findUniqueOrThrow({ where: { id: ok.id } })
    expect(after).toMatchObject({ status: "SUBMITTED", checkerId: null, appliedAt: null })
    expect(await db.decisionEngineConfig.count({ where: { tenantId: lender.tenantId } })).toBe(0)
  })

  it("lets exactly one of two concurrent approvals win", async () => {
    const d = await draft({ name: "Race" })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    const results = await Promise.allSettled([
      approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id }),
      approve({ tenantId: lender.tenantId, actor: asChecker2(lender), id: d.id }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await db.decisionRuleSetVersion.count({ where: { tenantId: lender.tenantId, changeRequestId: d.id } })).toBe(1)
  })

  it("needs the permission of the kind, and a note to reject", async () => {
    await expect(createDraft({ tenantId: lender.tenantId, actor: asOfficer(lender), kind: RULE_SET_KIND, title: "x", payload: payload() })).rejects.toMatchObject({ code: "FORBIDDEN" })
    const d = await draft({ name: "Reject me" })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    await expect(approve({ tenantId: lender.tenantId, actor: asOfficer(lender), id: d.id })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(reject({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id, note: "  " })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
    const r = await reject({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id, note: "Cut-off too tight" })
    expect(r).toMatchObject({ status: "REJECTED", decisionNote: "Cut-off too tight" })
    expect(await db.decisionRuleSetVersion.count({ where: { tenantId: lender.tenantId, changeRequestId: d.id } })).toBe(0)
  })

  it("lets only the maker edit a draft, and freezes the payload from submission", async () => {
    const d = await draft({ name: "Editable" })
    await expect(updateDraft({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id, title: "Hijack" })).rejects.toMatchObject({ code: "NOT_MAKER" })
    const u = await updateDraft({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id, payload: payload({ name: "Edited" }) })
    expect((u.payload as { name: string }).name).toBe("Edited")
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    await expect(updateDraft({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id, title: "Late" })).rejects.toMatchObject({ code: "WRONG_STATE" })
    expect(await refusal(sql(`UPDATE "ChangeRequest" SET "payload"='{"x":1}'::jsonb WHERE "id"='${d.id}'`))).toContain("moves only")
    expect(await refusal(sql(`UPDATE "ChangeRequest" SET "payload"='{"x":1}'::jsonb, "status"='APPROVED', "checkerId"='${lender.checkerId}', "decidedAt"=now(), "appliedAt"=now() WHERE "id"='${d.id}'`))).toContain("payload never change after submission")
    const w = await withdraw({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    expect(w.status).toBe("WITHDRAWN")
    await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id })).rejects.toBeInstanceOf(ChangeRequestError)
  })

  it("refuses an invalid payload with every problem listed", async () => {
    await expect(draft({ rules: [{ id: "BAD" }], effectiveFrom: "tomorrow" })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
  })

  it("refuses skipped steps, deletes and truncates at the database", async () => {
    const d = await draft({ name: "Steps" })
    expect(await refusal(sql(`UPDATE "ChangeRequest" SET "status"='APPROVED', "checkerId"='${lender.checkerId}', "decidedAt"=now(), "appliedAt"=now(), "submittedAt"=now() WHERE "id"='${d.id}'`))).toContain("moves only")
    expect(await refusal(sql(`DELETE FROM "ChangeRequest" WHERE "id"='${d.id}'`))).toContain("never deleted")
    expect(await refusal(sql(`TRUNCATE "ChangeRequest" CASCADE`))).toContain("never deleted")
    expect(await refusal(sql(`INSERT INTO "ChangeRequest" ("id","tenantId","kind","title","payload","status","makerId","updatedAt") VALUES ('x_${d.id}','${lender.tenantId}','DECISION_RULE_SET','t','{}','SUBMITTED','${lender.makerId}',now())`))).toContain("created as a DRAFT")
    expect(await refusal(sql(`INSERT INTO "ChangeRequest" ("id","tenantId","kind","title","payload","makerId","updatedAt") VALUES ('y_${d.id}','${lender.tenantId}','lower','t','{}','${lender.makerId}',now())`))).toContain("ChangeRequest_kind")
  })

  it("refuses a rule set version that no approved request made, and any change to one", async () => {
    const d = await draft({ name: "Not approved" })
    const insert = (changeRequestId: string, version: number) => sql(`INSERT INTO "DecisionRuleSetVersion" ("id","tenantId","scopeKey","version","name","rules","effectiveFrom","challengerOnly","changeRequestId")
      VALUES ('v_${version}_${d.id}','${lender.tenantId}','ALL',${version},'Forged','[]'::jsonb,'2026-01-01',false,'${changeRequestId}')`)
    expect(await refusal(insert(d.id, 900))).toContain("approved DECISION_RULE_SET")
    expect(await refusal(insert("no-such-request", 901))).toContain("approved DECISION_RULE_SET")
    const version = await db.decisionRuleSetVersion.findFirstOrThrow({ where: { tenantId: lender.tenantId } })
    expect(await refusal(sql(`UPDATE "DecisionRuleSetVersion" SET "name"='Edited' WHERE "id"='${version.id}'`))).toContain("never changes")
    expect(await refusal(sql(`DELETE FROM "DecisionRuleSetVersion" WHERE "id"='${version.id}'`))).toContain("never changes")
  })

  it("refuses an approval over a change approved in between (STALE), for rule sets and for engine settings, and applies nothing", async () => {
    const first = await draft({ name: "Concurrent A" })
    const second = await draft({ name: "Concurrent B" })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: first.id })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: second.id })
    await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: first.id })
    await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: second.id })).rejects.toMatchObject({ code: "STALE", status: 409 })
    expect(await db.decisionRuleSetVersion.count({ where: { tenantId: lender.tenantId, changeRequestId: second.id } })).toBe(0)
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("SUBMITTED")

    const cfgA = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title: "Settings A", payload: engineConfig() })
    const cfgB = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title: "Settings B", payload: engineConfig({ mode: "OFF", channels: [], productIds: [] }) })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: cfgA.id })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: cfgB.id })
    await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: cfgA.id })
    await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: cfgB.id })).rejects.toMatchObject({ code: "STALE" })
    expect((await db.decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: lender.tenantId } })).mode).toBe("SHADOW")
  })

  it("two simultaneous approvals that would both create the next version number: one wins, the other is a clean STALE, never a 500", async () => {
    const x = await draft({ name: "Race X" })
    const y = await draft({ name: "Race Y" })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: x.id })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: y.id })
    const results = await Promise.allSettled([
      approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: x.id }),
      approve({ tenantId: lender.tenantId, actor: asChecker2(lender), id: y.id }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(lost.reason).toMatchObject({ code: "STALE", status: 409 })
    const versions = await db.decisionRuleSetVersion.findMany({ where: { tenantId: lender.tenantId, scopeKey: "ALL" }, select: { version: true } })
    expect(new Set(versions.map((v) => v.version)).size).toBe(versions.length)
  })

  it("the database ties engine settings to an approved request: a forged row, a reused request and a hand edit are refused", async () => {
    const pending = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title: "Unapproved", payload: engineConfig() })
    const insert = (tenant: string, request: string) => sql(`INSERT INTO "DecisionEngineConfig" ("id","tenantId","mode","channels","productIds","changeRequestId","updatedAt") VALUES ('forged_${request}','${tenant}','LIVE',ARRAY['STAFF'],ARRAY['p'],'${request}',now())`)
    const other = await createLender(db)
    await sql(`DELETE FROM "DecisionEngineConfig" WHERE "tenantId" = '${other.tenantId}'`)
    expect(await refusal(insert(other.tenantId, pending.id))).toContain("written only by an approved DECISION_ENGINE_CONFIG")
    expect(await refusal(insert(other.tenantId, "no-such-request"))).toContain("written only by an approved DECISION_ENGINE_CONFIG")
    // A different tenant's approved request cannot back this tenant's settings.
    const mine = await db.decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: lender.tenantId } })
    expect(await refusal(insert(other.tenantId, mine.changeRequestId))).toContain("written only by an approved")
    // The row cannot be edited under the request that last wrote it, nor under an unapproved or other-kind one.
    expect(await refusal(sql(`UPDATE "DecisionEngineConfig" SET "mode"='LIVE' WHERE "tenantId"='${lender.tenantId}'`))).toContain("newly approved")
    expect(await refusal(sql(`UPDATE "DecisionEngineConfig" SET "mode"='LIVE', "changeRequestId"='${pending.id}' WHERE "tenantId"='${lender.tenantId}'`))).toContain("written only by an approved")
    const ruleSetRequest = (await db.decisionRuleSetVersion.findFirstOrThrow({ where: { tenantId: lender.tenantId } })).changeRequestId
    expect(await refusal(sql(`UPDATE "DecisionEngineConfig" SET "mode"='LIVE', "changeRequestId"='${ruleSetRequest}' WHERE "tenantId"='${lender.tenantId}'`))).toContain("written only by an approved")
  })

  it("keeps the s71 sign-off tied to the approved notice, and the system user unable to sign in", async () => {
    expect(await refusal(sql(`UPDATE "DecisionEngineConfig" SET "s71SignedOffAt"=now() WHERE "tenantId"='${lender.tenantId}'`))).toMatch(/s71_signoff|newly approved/)
    const live = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title: "Live with sign-off", payload: engineConfig({ mode: "LIVE", s71SignOff: true, automatedDeclineNotice: "This decision was made by automated means; you may ask for a person to review it." }) })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: live.id })
    await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: live.id })
    const config = await db.decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: lender.tenantId } })
    expect(config).toMatchObject({ mode: "LIVE", s71SignedOffById: lender.checkerId })
    expect(config.s71SignedOffAt).not.toBeNull()
    const system = await db.user.findFirstOrThrow({ where: { tenantId: lender.tenantId, isSystem: true } })
    expect(system).toMatchObject({ active: false, password: "!", role: "LOAN_ADMIN", name: "Automated decisioning" })
    expect(await refusal(sql(`UPDATE "User" SET "active" = true WHERE "id" = '${system.id}'`))).toContain("User_system_no_login")
    expect(await refusal(sql(`UPDATE "User" SET "password" = '$2a$10$abcdefghijklmnopqrstuv' WHERE "id" = '${system.id}'`))).toContain("User_system_no_login")
    expect(await refusal(sql(`INSERT INTO "User" ("id","email","password","role","active","isSystem","tenantId","updatedAt") VALUES ('sys2_${lender.tenantId}','sys2@x.invalid','!','LOAN_ADMIN',false,true,'${lender.tenantId}',now())`))).toMatch(/already exists|User_one_system_per_tenant/)
    // Re-approving the same settings keeps the one system user and the original sign-off.
    const again = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title: "Same again", payload: engineConfig({ mode: "LIVE", s71SignOff: true, automatedDeclineNotice: "This decision was made by automated means; you may ask for a person to review it." }) })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: again.id })
    await approve({ tenantId: lender.tenantId, actor: asChecker2(lender), id: again.id })
    expect(await db.user.count({ where: { tenantId: lender.tenantId, isSystem: true } })).toBe(1)
    expect((await db.decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: lender.tenantId } })).s71SignedOffById).toBe(lender.checkerId)
  })

  it("a risk grade is all-or-nothing on the application", async () => {
    const version = await db.decisionRuleSetVersion.findFirstOrThrow({ where: { tenantId: lender.tenantId } })
    const client = await db.client.create({ data: { tenantId: lender.tenantId, idNumber: `92${Date.now().toString().slice(-11)}`, firstName: "G", lastName: "T", email: `g${Date.now()}@c.invalid`, phone: "0820000002" } })
    const app = await db.loanApplication.create({ data: { tenantId: lender.tenantId, reference: `APP-G${Date.now()}`, clientId: client.id, productId: lender.productId, appliedAmount: 1, appliedTermDays: 1 } })
    expect(await refusal(sql(`UPDATE "LoanApplication" SET "riskGrade"='A', "riskGradedAt"=now() WHERE "id"='${app.id}'`))).toContain("LoanApplication_risk_grade_shape")
    expect(await refusal(sql(`UPDATE "LoanApplication" SET "riskScore"=5 WHERE "id"='${app.id}'`))).toContain("LoanApplication_risk_grade_shape")
    await sql(`UPDATE "LoanApplication" SET "riskGrade"='A', "riskGradedAt"=now(), "riskGradeVersionId"='${version.id}', "riskGradeRank"=0, "riskScore"=9, "riskPricingTier"='PRIME' WHERE "id"='${app.id}'`)
    expect(await db.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).toMatchObject({ riskGrade: "A", riskGradeRank: 0, riskPricingTier: "PRIME" })
  })

  const approvedSettings = async (title: string, over: Record<string, unknown>, by: "checker" | "checker2" = "checker") => {
    const d = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title, payload: engineConfig(over) })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    await approve({ tenantId: lender.tenantId, actor: by === "checker" ? asChecker(lender) : asChecker2(lender), id: d.id })
    return d.id
  }
  const NOTICE = "This decision was made by automated means; you may ask for a person to review it."
  const rewrite = (set: string, requestId: string) => sql(`UPDATE "DecisionEngineConfig" SET ${set}, "changeRequestId" = '${requestId}' WHERE "tenantId" = '${lender.tenantId}'`)

  it("the engine-settings trigger holds what was approved: the mode, the repayment method, the share and the sign-off", async () => {
    const older = await approvedSettings("Shadow, staff channel", { mode: "SHADOW" })
    await approvedSettings("Off", { mode: "OFF", channels: [], productIds: [] })
    // The older request is approved and is not the row's current one, but it approved SHADOW with no share and no sign-off.
    expect(await refusal(rewrite(`"mode" = 'LIVE'`, older))).toContain("must match the approved change request")
    expect(await refusal(rewrite(`"repaymentMethod" = 'DEBIT_ORDER'`, older))).toContain("must match the approved change request")
    expect(await refusal(rewrite(`"challengerPercent" = 10`, older))).toContain("must match the approved change request")
    expect(await refusal(rewrite(`"s71SignedOffAt" = now(), "s71SignedOffById" = '${lender.checkerId}', "automatedDeclineNotice" = '${NOTICE}'`, older))).toContain("must match the approved change request")
  })

  it("the engine-settings trigger also holds the channels, the products, the challenger and the notice wording", async () => {
    const older = await approvedSettings("Shadow, narrow", { mode: "SHADOW" })
    const challenger = await db.decisionRuleSetVersion.findFirst({ where: { tenantId: lender.tenantId }, select: { id: true } })
    await approvedSettings("Off again", { mode: "OFF", channels: [], productIds: [] })
    // The row put back to exactly what the older request approved, but for the one column under test.
    const asApproved: Record<string, string> = {
      mode: `'SHADOW'`, channels: `ARRAY['STAFF']::TEXT[]`, productIds: `ARRAY['${lender.productId}']::TEXT[]`, repaymentMethod: `'EFT'`,
      challengerVersionId: "NULL", challengerPercent: "0", automatedDeclineNotice: "NULL",
    }
    const only = (over: Record<string, string>) => rewrite(Object.entries({ ...asApproved, ...over }).map(([k, v]) => `"${k}" = ${v}`).join(", "), older)
    const REFUSED = "must match the approved change request"
    expect(await refusal(only({ channels: `ARRAY['PORTAL']::TEXT[]` }))).toContain(REFUSED)
    expect(await refusal(only({ channels: `ARRAY['STAFF','PORTAL']::TEXT[]` }))).toContain(REFUSED)
    expect(await refusal(only({ channels: `ARRAY[]::TEXT[]` }))).toContain(REFUSED)
    expect(await refusal(only({ productIds: `ARRAY['some-other-product']::TEXT[]` }))).toContain(REFUSED)
    expect(await refusal(only({ productIds: `ARRAY[]::TEXT[]` }))).toContain(REFUSED)
    expect(await refusal(only({ automatedDeclineNotice: `'${NOTICE}'` }))).toContain(REFUSED)
    expect(challenger).toBeTruthy()
    expect(await refusal(only({ challengerVersionId: `'${challenger!.id}'` }))).toContain(REFUSED)
    // Put back exactly as approved, the older request is a legitimate source of the row: only the columns above were wrong.
    await only({})
  })

  it("settings that go LIVE or record the s71 sign-off need a SUPER_ADMIN: an ADMIN checker is refused, and nothing is written", async () => {
    for (const over of [{ mode: "LIVE" }, { mode: "SHADOW", s71SignOff: true, automatedDeclineNotice: NOTICE }]) {
      const d = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title: "High risk", payload: engineConfig(over) })
      await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
      await expect(approve({ tenantId: lender.tenantId, actor: asAdminChecker(lender), id: d.id })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
      expect((await db.changeRequest.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("SUBMITTED")
      expect((await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id })).status).toBe("APPROVED")
    }
  })

  it("a checker who created or changed the maker's account in the last 30 days cannot approve what that account drafted (sock puppet)", async () => {
    const person = async (label: string) => {
      const u = await db.user.create({ data: { id: `u_${label}_${lender.tenantId}`, tenantId: lender.tenantId, email: `${label}_${lender.tenantId}@test.invalid`, password: "x", role: "ADMIN", createdAt: new Date(Date.now() - 90 * 86_400_000) } })
      return { id: u.id, email: u.email, role: "ADMIN", totpVerified: true }
    }
    const trail = (action: string, userId: string, entityId: string, ageDays: number) =>
      db.auditLog.create({ data: { tenantId: lender.tenantId, action, entity: "User", entityId, userId, createdAt: new Date(Date.now() - ageDays * 86_400_000), newValue: {} } })
    const submitted = async (maker: Awaited<ReturnType<typeof person>>, name: string) => {
      const d = await createDraft({ tenantId: lender.tenantId, actor: maker, kind: RULE_SET_KIND, title: name, payload: payload({ name }) })
      await submit({ tenantId: lender.tenantId, actor: maker, id: d.id })
      return d.id
    }
    const puppet = await person("puppet")
    const fromPuppet = await submitted(puppet, "Puppet rules")
    // The checker made the account yesterday: refused, nothing written. A password, role or second-factor reset counts the same.
    await trail("USER_CREATED", lender.checkerId, puppet.id, 1)
    await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: fromPuppet })).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED", status: 403 })
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: fromPuppet } })).status).toBe("SUBMITTED")
    await trail("TOTP_RESET_BY_ADMIN", lender.checker2Id, puppet.id, 29)
    await expect(approve({ tenantId: lender.tenantId, actor: asChecker2(lender), id: fromPuppet })).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
    // Someone with no hand in the account is a second person; so is one whose last change was more than 30 days ago.
    const old = await person("old")
    await trail("USER_UPDATED", lender.checker2Id, old.id, 31)
    expect((await approve({ tenantId: lender.tenantId, actor: asChecker2(lender), id: await submitted(old, "Old account rules") })).status).toBe("APPROVED")
    const untouched = await person("untouched")
    expect((await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: await submitted(untouched, "Untouched rules") })).status).toBe("APPROVED")
  })

  describe("input staff (LoanApplication.inputStaffIds, Client.inputStaffIds)", () => {
    const staffOf = async (applicationId: string) => (await db.loanApplication.findUniqueOrThrow({ where: { id: applicationId } })).inputStaffIds
    const editClient = (clientId: string, staff: string[]) => db.client.update({ where: { id: clientId }, data: { inputStaffIds: staff } })

    it("an application made after a staff edit of its client starts with that editor", async () => {
      const first = await createApplication(db, lender, { status: "SUBMITTED" })
      await editClient(first.clientId, ["editor-before"])
      await db.loanApplication.update({ where: { id: first.applicationId }, data: { status: "CANCELLED" } })
      // A second application for the same client (a repeat loan) is created after the edit.
      const second = await db.loanApplication.create({ data: { tenantId: lender.tenantId, reference: `APP-INH-${Date.now()}`, clientId: first.clientId, productId: lender.productId, appliedAmount: 100_000, appliedTermDays: 30, status: "DRAFT", inputStaffIds: ["captured-by"] } })
      expect((await staffOf(second.id)).sort()).toEqual(["captured-by", "editor-before"])
    })

    it("an edit made after the application was created is taken up when its review starts, and not before", async () => {
      const { applicationId, clientId } = await createApplication(db, lender, { status: "SUBMITTED" })
      await editClient(clientId, ["editor-late"])
      expect(await staffOf(applicationId)).toEqual([])
      await db.loanApplication.update({ where: { id: applicationId }, data: { status: "UNDER_REVIEW" } })
      expect(await staffOf(applicationId)).toEqual(["editor-late"])
      // A later status move does not copy later edits: only an application's review start does.
      await editClient(clientId, ["editor-late", "editor-after-review"])
      await db.loanApplication.update({ where: { id: applicationId }, data: { status: "CANCELLED" } })
      expect(await staffOf(applicationId)).toEqual(["editor-late"])
    })

    it("a lead's list only grows and is never null", async () => {
      const lead = await db.lead.create({ data: { tenantId: lender.tenantId, firstName: "Lead", lastName: "Staff", phone: "0820000099", source: "MANUAL", status: "NEW", inputStaffIds: ["l1", "l2"] } })
      expect(await refusal(sql(`UPDATE "Lead" SET "inputStaffIds" = ARRAY['l1'] WHERE "id" = '${lead.id}'`))).toContain("cannot be removed from it")
      expect(await refusal(sql(`UPDATE "Lead" SET "inputStaffIds" = NULL WHERE "id" = '${lead.id}'`))).toMatch(/cannot be removed|null value|23502/i)
      await sql(`UPDATE "Lead" SET "inputStaffIds" = ARRAY['l1','l2','l3'] WHERE "id" = '${lead.id}'`)
    })

    it("the lists are never null, and the client's only grows", async () => {
      const { clientId, applicationId } = await createApplication(db, lender, { status: "SUBMITTED" })
      await editClient(clientId, ["a", "b"])
      expect(await refusal(sql(`UPDATE "Client" SET "inputStaffIds" = ARRAY['a'] WHERE "id" = '${clientId}'`))).toContain("cannot be removed from it")
      expect(await refusal(sql(`UPDATE "Client" SET "inputStaffIds" = NULL WHERE "id" = '${clientId}'`))).toMatch(/cannot be removed|null value|23502/i)
      expect(await refusal(sql(`UPDATE "LoanApplication" SET "inputStaffIds" = NULL WHERE "id" = '${applicationId}'`))).toMatch(/null value|not-null|NOT NULL|23502/i)
    })
  })

  it("an account younger than 30 days that a tenant user or SSO created cannot have its changes approved; one the operator or the seed made can", async () => {
    const young = async (label: string, origin: { action: string; userId: string | null } | null) => {
      const u = await db.user.create({ data: { id: `u_${label}_${lender.tenantId}`, tenantId: lender.tenantId, email: `${label}_${lender.tenantId}@test.invalid`, password: "x", role: "ADMIN", createdAt: new Date(Date.now() - 5 * 86_400_000) } })
      if (origin) await db.auditLog.create({ data: { tenantId: lender.tenantId, action: origin.action, entity: "User", entityId: u.id, userId: origin.userId, newValue: {} } })
      const actor = { id: u.id, email: u.email, role: "ADMIN", totpVerified: true }
      const d = await createDraft({ tenantId: lender.tenantId, actor, kind: RULE_SET_KIND, title: label, payload: payload({ name: `${label} rules` }) })
      await submit({ tenantId: lender.tenantId, actor, id: d.id })
      return { id: u.id, actor, requestId: d.id }
    }
    // Minted by a tenant admin, or provisioned by SSO on first sign-in: refused while it is young.
    const byAdmin = await young("byadmin", { action: "USER_CREATED", userId: lender.checker2Id })
    await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: byAdmin.requestId })).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
    const bySso = await young("bysso", { action: "SSO_USER_PROVISIONED", userId: null })
    await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: bySso.requestId })).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
    // Operator provisioning, bootstrap and the seed write no creation row: exempt, however young.
    const bySeed = await young("byseed", null)
    expect((await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: bySeed.requestId })).status).toBe("APPROVED")
    // The same account is no longer young after 30 days.
    await db.$executeRawUnsafe(`UPDATE "User" SET "createdAt" = now() - interval '31 days' WHERE "id" = '${byAdmin.id}'`)
    // (Its earlier draft went stale when another rule set was approved; a fresh one is approved.)
    const fresh = await createDraft({ tenantId: lender.tenantId, actor: byAdmin.actor, kind: RULE_SET_KIND, title: "later", payload: payload({ name: "Later rules" }) })
    await submit({ tenantId: lender.tenantId, actor: byAdmin.actor, id: fresh.id })
    expect((await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: fresh.id })).status).toBe("APPROVED")
  })

  it("an account whose sign-in, second factor, role, email or password changed in the last 30 days cannot have its changes approved, whoever wrote the row", async () => {
    const taken = async (label: string, trail: { action: string; oldValue?: object; newValue?: object; ageDays: number } | null) => {
      const u = await db.user.create({ data: { id: `u_${label}_${lender.tenantId}`, tenantId: lender.tenantId, email: `${label}_${lender.tenantId}@test.invalid`, password: "x", role: "ADMIN", createdAt: new Date(Date.now() - 90 * 86_400_000) } })
      if (trail) await db.auditLog.create({ data: { tenantId: lender.tenantId, action: trail.action, entity: "User", entityId: u.id, userId: u.id, oldValue: trail.oldValue ?? {}, newValue: trail.newValue ?? {}, createdAt: new Date(Date.now() - trail.ageDays * 86_400_000) } })
      const actor = { id: u.id, email: u.email, role: "ADMIN", totpVerified: true }
      const d = await createDraft({ tenantId: lender.tenantId, actor, kind: RULE_SET_KIND, title: label, payload: payload({ name: `${label} rules` }) })
      await submit({ tenantId: lender.tenantId, actor, id: d.id })
      return d.id
    }
    const refused = async (label: string, trail: Parameters<typeof taken>[1]) =>
      expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: await taken(label, trail) })).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
    await refused("sso", { action: "SSO_IDENTITY_LINKED", ageDays: 3 })
    await refused("synced", { action: "SSO_ROLE_SYNCED", oldValue: { role: "READONLY" }, newValue: { role: "ADMIN" }, ageDays: 3 })
    await refused("totp", { action: "TOTP_ENROLLED", ageDays: 10 })
    await refused("role", { action: "USER_UPDATED", oldValue: { role: "LOAN_ADMIN" }, newValue: { role: "ADMIN" }, ageDays: 5 })
    await refused("email", { action: "USER_UPDATED", oldValue: { email: "old@x.invalid" }, newValue: { email: "new@x.invalid" }, ageDays: 5 })
    await refused("pw", { action: "USER_UPDATED", newValue: { passwordChanged: true }, ageDays: 5 })
    // A rename, or any of it more than 30 days ago, does not count.
    const renamed = await taken("renamed", { action: "USER_UPDATED", newValue: { changed: ["name"] }, ageDays: 2 })
    expect((await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: renamed })).status).toBe("APPROVED")
    const old = await taken("oldtotp", { action: "TOTP_ENROLLED", ageDays: 45 })
    expect((await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: old })).status).toBe("APPROVED")
  })

  it("a LIVE or s71 settings change needs a maker account 30 days old even where nobody on record created it (operator, seed)", async () => {
    const young = await db.user.create({ data: { id: `u_youngop_${lender.tenantId}`, tenantId: lender.tenantId, email: `youngop_${lender.tenantId}@test.invalid`, password: "x", role: "ADMIN", createdAt: new Date(Date.now() - 4 * 86_400_000) } })
    const asYoung = { id: young.id, email: young.email, role: "ADMIN", totpVerified: true }
    const live = await createDraft({ tenantId: lender.tenantId, actor: asYoung, kind: "DECISION_ENGINE_CONFIG", title: "Live", payload: engineConfig({ mode: "LIVE" }) })
    await submit({ tenantId: lender.tenantId, actor: asYoung, id: live.id })
    await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: live.id })).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
    const shadow = await createDraft({ tenantId: lender.tenantId, actor: asYoung, kind: "DECISION_ENGINE_CONFIG", title: "Shadow", payload: engineConfig({ mode: "SHADOW" }) })
    await submit({ tenantId: lender.tenantId, actor: asYoung, id: shadow.id })
    expect((await approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: shadow.id })).status).toBe("APPROVED")
  })

  it("settings that go LIVE or record the s71 sign-off can only be drafted by an ADMIN or above", async () => {
    const loanAdmin = { id: lender.makerId, email: `${lender.makerId}@test.invalid`, role: "LOAN_ADMIN", totpVerified: true }
    for (const over of [{ mode: "LIVE" }, { mode: "SHADOW", s71SignOff: true, automatedDeclineNotice: NOTICE }]) {
      await expect(createDraft({ tenantId: lender.tenantId, actor: loanAdmin, kind: "DECISION_ENGINE_CONFIG", title: "x", payload: engineConfig(over) })).rejects.toMatchObject({ code: "FORBIDDEN" })
    }
    expect((await createDraft({ tenantId: lender.tenantId, actor: loanAdmin, kind: "DECISION_ENGINE_CONFIG", title: "Shadow", payload: engineConfig({ mode: "SHADOW" }) })).status).toBe("DRAFT")
  })

  it("a sign-off is recorded against the checker who approved it; anyone else's name is refused", async () => {
    const first = await approvedSettings("Sign-off A", { mode: "SHADOW", s71SignOff: true, automatedDeclineNotice: NOTICE }, "checker2")
    await approvedSettings("Sign-off B", { mode: "SHADOW", s71SignOff: true, automatedDeclineNotice: `${NOTICE} Contact us.` }, "checker2")
    expect((await db.decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: lender.tenantId } })).s71SignedOffById).toBe(lender.checker2Id)
    // Request A's checker was checker2, and the row's current sign-off is checker2's too: naming anyone else is a forgery.
    // (Everything else is put back to what request A approved, so the signer is the only thing wrong.)
    const asApprovedByA = `"automatedDeclineNotice" = '${NOTICE}', "s71SignedOffById"`
    expect(await refusal(rewrite(`${asApprovedByA} = '${lender.makerId}'`, first))).toContain("recorded against the checker who approved the change")
    expect(await refusal(rewrite(`${asApprovedByA} = '${lender.checkerId}'`, first))).toContain("recorded against the checker who approved the change")
    // Carrying the existing name over, or the approving checker's own, is not.
    await rewrite(`${asApprovedByA} = '${lender.checker2Id}'`, first)
  })

  it("an older-format draft cannot be submitted (STALE 409); editing it brings it up to date", async () => {
    const d = await draft({ name: "Old format" })
    await sql(`UPDATE "ChangeRequest" SET "payloadVersion" = 0 WHERE "id" = '${d.id}'`)
    await expect(submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })).rejects.toMatchObject({ code: "STALE", status: 409 })
    await updateDraft({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id, payload: payload({ name: "Old format, re-entered" }) })
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: d.id } })).payloadVersion).toBe(1)
    expect((await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })).status).toBe("SUBMITTED")
  })

  it("the system user must be LOAN_ADMIN, and the database refuses another role", async () => {
    const system = await db.user.findFirstOrThrow({ where: { tenantId: lender.tenantId, isSystem: true } })
    expect(await refusal(sql(`UPDATE "User" SET "role" = 'READONLY' WHERE "id" = '${system.id}'`))).toContain("User_system_no_login")
  })
})
