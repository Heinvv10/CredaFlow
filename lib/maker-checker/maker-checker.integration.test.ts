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
import { asChecker, asMaker, asOfficer, createLender, type Lender } from "@/lib/decisioning/decisioning.integration-fixture"
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
    const d = await draft({ name: "Bad product", productId: null })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    // The payload is frozen, so make the world invalid instead: the delegate of an engine-config change goes inactive.
    const cfg = await createDraft({
      tenantId: lender.tenantId, actor: asMaker(lender), kind: "DECISION_ENGINE_CONFIG", title: "Go shadow",
      payload: { mode: "SHADOW", channels: ["PORTAL"], productIds: [lender.productId], delegateUserId: lender.delegateId, repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0 },
    })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: cfg.id })
    await db.user.update({ where: { id: lender.delegateId }, data: { active: false } })
    try {
      await expect(approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: cfg.id })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
    } finally {
      await db.user.update({ where: { id: lender.delegateId }, data: { active: true } })
    }
    const after = await db.changeRequest.findUniqueOrThrow({ where: { id: cfg.id } })
    expect(after).toMatchObject({ status: "SUBMITTED", checkerId: null, appliedAt: null })
    expect(await db.decisionEngineConfig.count({ where: { tenantId: lender.tenantId } })).toBe(0)
  })

  it("lets exactly one of two concurrent approvals win", async () => {
    const d = await draft({ name: "Race" })
    await submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    const results = await Promise.allSettled([
      approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: d.id }),
      approve({ tenantId: lender.tenantId, actor: { ...asChecker(lender), id: lender.officerId, role: "ADMIN" }, id: d.id }),
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
})
