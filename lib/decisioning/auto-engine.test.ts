// The engine's controls at unit level (Prisma and the staff decision path mocked; the
// real gates, triggers and RLS are in auto-decision.integration.test.ts). Several of
// these began as breaker reproductions against PR #256.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  decideApplication: vi.fn(),
  loadDecisionFacts: vi.fn(),
  totpRequired: vi.fn(async () => true),
  audits: [] as unknown[],
}))

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }))
vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: (_t: string, fn: () => unknown) => fn() }))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_o, k) => String(k) }),
  logAuditStrict: vi.fn(async (p: unknown) => { h.audits.push(p) }),
  logAudit: vi.fn(async (p: unknown) => { h.audits.push(p) }),
}))
vi.mock("@/lib/learning-loop/decision-log", async (orig) => ({ ...(await orig<object>()), recordDecisions: vi.fn(async () => {}) }))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => {}) }))
vi.mock("@/app/api/applications/[id]/decide/decide-application", () => ({ decideApplication: h.decideApplication }))
vi.mock("./load-facts", () => ({ loadDecisionFacts: h.loadDecisionFacts }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: h.totpRequired, STAFF_TOTP_REQUIRED_DEFAULT: true }))

import { approveThroughStaffPath, declineThroughStaffPath, refer, writeGrade, type RunContext } from "./auto-actions"
import { runAutoDecision } from "./auto-decision"
import { inChallengerGroup } from "./select-version"
import { approve } from "@/lib/maker-checker/service"

const RULES = [{ id: "r1", name: "R1", outcome: "REFER", reasonCode: "R_ONE", when: { field: "bureauJudgement", op: "eq", value: true } }]
const KNOCK = [{ id: "k1", name: "K1", outcome: "KNOCK_OUT", reasonCode: "K_ONE", declineCategory: "POLICY", when: { field: "monthlyIncomeCents", op: "gt", value: 0 } }]
const CARD = { baseScore: 0, characteristics: [{ field: "monthlyIncomeCents", missingPoints: 0, bins: [{ min: 0, points: 120 }] }], bands: [{ minScore: 100, grade: "A", action: "ALLOW", pricingTier: "PRIME" }, { minScore: 0, grade: "B", action: "REFER" }] }
const UPDATED_AT = new Date("2026-10-29T07:00:00Z")
const SYSTEM = { id: "sys1", email: "automated-decisioning+t@system.invalid", role: "LOAN_ADMIN" }

function version(over: Record<string, unknown> = {}) {
  return { id: "v1", tenantId: "t", scopeKey: "ALL", version: 1, effectiveFrom: new Date("2026-01-01T00:00:00Z"), challengerOnly: false, rules: RULES, scorecard: null, ...over }
}
function config(over: Record<string, unknown> = {}) {
  return { mode: "LIVE", channels: ["STAFF"], productIds: ["p1"], challengerVersionId: null, challengerPercent: 0, s71SignedOffAt: new Date("2026-10-01"), repaymentMethod: "EFT", ...over }
}
function loaded() {
  return { application: { id: "app-1", clientId: "c1", productId: "p1", status: "UNDER_REVIEW", updatedAt: UPDATED_AT, submittedAt: null }, facts: { channel: "STAFF", monthlyIncomeCents: 500_000, bureauJudgement: false }, bureauCheckId: "b1", affordabilitySource: "LIVE" }
}
function stubDb(over: { config?: unknown; versions?: unknown[]; user?: unknown; signoff?: unknown } = {}) {
  const writes = { runs: [] as unknown[], gradeUpdates: [] as unknown[], tx: {} as Record<string, unknown> }
  const tx = {
    autoDecisionRun: { create: vi.fn(async (a: unknown) => { writes.runs.push(a); return { id: `run${writes.runs.length}` } }) },
    loanApplication: { updateMany: vi.fn(async (a: unknown) => { writes.gradeUpdates.push(a); return { count: 1 } }) },
    auditLog: { create: vi.fn() },
    creditDecisionRecord: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(async () => 0),
    // The decline transaction re-reads the s71 sign-off and notice (FOR SHARE).
    $queryRaw: vi.fn(async () => [over.signoff === undefined ? { s71SignedOffAt: new Date("2026-10-01T00:00:00Z"), automatedDeclineNotice: "Approved wording now." } : over.signoff]),
  }
  Object.assign(h.prisma, {
    decisionEngineConfig: { findUnique: vi.fn(async () => over.config ?? config()) },
    decisionRuleSetVersion: {
      findMany: vi.fn(async () => over.versions ?? [version()]),
      findFirst: vi.fn(async (a: { where: { id: string } }) => (over.versions ?? [version()]).find((v) => (v as { id: string }).id === a.where.id)),
    },
    user: { findFirst: vi.fn(async () => ("user" in over ? over.user : SYSTEM)) },
    autoDecisionRun: tx.autoDecisionRun,
    loanApplication: tx.loanApplication,
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  })
  writes.tx = tx
  return writes
}
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
const run = () => runAutoDecision({ tenantId: "t", applicationId: "app-1", trigger: "MANUAL", now: new Date("2026-10-29T08:00:00Z") })

beforeEach(() => {
  for (const k of Object.keys(h.prisma)) delete h.prisma[k]
  h.decideApplication.mockReset()
  h.loadDecisionFacts.mockReset().mockResolvedValue(loaded())
  h.totpRequired.mockReset().mockResolvedValue(true)
  h.audits = []
})

function ctxWith(over: Partial<RunContext> = {}): RunContext {
  return {
    tenantId: "t", applicationId: "app-1", trigger: "MANUAL", mode: "LIVE", role: "CHAMPION",
    version: { id: "v1", scopeKey: "ALL", version: 1 }, loaded: loaded() as never,
    verdict: { decision: "APPROVE", reasonCodes: ["RULES_PASSED"], riskGrade: "A", gradeRank: 0, score: 120, pricingTier: "PRIME", declineCategory: null, limitCapCents: null, hits: [] },
    startedAt: 0, now: new Date("2026-10-29T08:00:00Z"), ...over,
  }
}

describe("provenance of the engine settings (breaker 1)", () => {
  it("the database guards DecisionEngineConfig like DecisionRuleSetVersion: only an APPROVED DECISION_ENGINE_CONFIG request of the tenant may write it", () => {
    const dir = join(process.cwd(), "prisma/migrations")
    const sql = readdirSync(dir).filter((d) => !d.endsWith(".toml")).map((d) => readFileSync(join(dir, d, "migration.sql"), "utf8")).join("\n")
    expect(sql).toMatch(/guardDecisionEngineConfig[\s\S]*c\."kind" = 'DECISION_ENGINE_CONFIG' AND c\."status" = 'APPROVED'/)
    expect(sql).toMatch(/CREATE TRIGGER "DecisionEngineConfig_guard" BEFORE INSERT OR UPDATE/)
  })
})

describe("a challenger runs from its effective date, like any version (breaker 2)", () => {
  it("does not decide with a challenger whose effectiveFrom is in the future", async () => {
    const challenger = version({ id: "v-future", version: 2, effectiveFrom: new Date("2027-06-01T00:00:00Z"), challengerOnly: true })
    let appId = ""
    for (let i = 0; i < 1000 && !appId; i++) if (inChallengerGroup(`a${i}`, challenger.id, 50)) appId = `a${i}`
    stubDb({ config: config({ mode: "SHADOW", challengerVersionId: challenger.id, challengerPercent: 50 }), versions: [version(), challenger] })
    const out = await runAutoDecision({ tenantId: "t", applicationId: appId, trigger: "MANUAL", now: new Date("2026-10-29T08:00:00Z") })
    expect(out.status === "RAN" && out.role).toBe("CHAMPION")
  })

  it("decides with it once the day has come", async () => {
    const challenger = version({ id: "v-now", version: 2, effectiveFrom: new Date("2026-10-29T00:00:00Z"), challengerOnly: true })
    let appId = ""
    for (let i = 0; i < 1000 && !appId; i++) if (inChallengerGroup(`a${i}`, challenger.id, 50)) appId = `a${i}`
    stubDb({ config: config({ mode: "SHADOW", challengerVersionId: challenger.id, challengerPercent: 50 }), versions: [version(), challenger] })
    const out = await runAutoDecision({ tenantId: "t", applicationId: appId, trigger: "MANUAL", now: new Date("2026-10-29T08:00:00Z") })
    expect(out.status === "RAN" && out.role).toBe("CHALLENGER")
  })
})

describe("the booking identity (breaker 3: no human delegate)", () => {
  it("refers, never decides, when the lender's system user is missing", async () => {
    const w = stubDb({ user: null })
    const out = await approveThroughStaffPath(ctxWith(), "EFT")
    expect(h.decideApplication).not.toHaveBeenCalled()
    expect(out).toMatchObject({ execution: "REFERRED" })
    expect(JSON.stringify(w.runs)).toContain("HARD_GATE_SYSTEM_USER_MISSING")
  })

  it("books under the system user, never a person, and hands the staff path the optimistic-lock timestamp", async () => {
    stubDb()
    h.decideApplication.mockResolvedValueOnce(ok())
    await approveThroughStaffPath(ctxWith(), "EFT")
    const call = h.decideApplication.mock.calls[0][0]
    expect(call.user).toMatchObject({ id: "sys1", role: "LOAN_ADMIN" })
    expect(call.automation.expectedUpdatedAt).toEqual(UPDATED_AT)
  })
})

describe("approving a change that switches the engine live needs a TOTP-verified session (breaker 4)", () => {
  it("refuses a password-only checker when the lender requires staff TOTP, before applying anything", async () => {
    const found = { id: "cr1", tenantId: "t", kind: "DECISION_ENGINE_CONFIG", status: "SUBMITTED", makerId: "u-maker", title: "go live", payloadVersion: 1, baseRef: "none",
      payload: { mode: "LIVE", channels: ["STAFF"], productIds: ["p1"], repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0, s71SignOff: false, automatedDeclineNotice: null } }
    const tx = { changeRequest: { findFirst: vi.fn(async () => found), updateMany: vi.fn(async () => ({ count: 1 })) }, decisionEngineConfig: { findUnique: vi.fn(), upsert: vi.fn() }, $executeRaw: vi.fn() }
    const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)), changeRequest: tx.changeRequest }
    const checker = { id: "u-checker", email: "c@x.invalid", role: "ADMIN", totpVerified: false }
    await expect(approve({ tenantId: "t", id: "cr1", actor: checker }, db as never)).rejects.toMatchObject({ code: "TOTP_REQUIRED" })
    expect(tx.decisionEngineConfig.upsert).not.toHaveBeenCalled()
  })
})

describe("an automatic decision acts only on the facts it read (breaker 5: one decline writer)", () => {
  it("declines through the staff decline path, with the optimistic-lock timestamp and no write of its own to the application", async () => {
    const w = stubDb()
    h.decideApplication.mockResolvedValueOnce(ok())
    const ctx = ctxWith({ verdict: { decision: "DECLINE", reasonCodes: ["K_ONE"], riskGrade: null, gradeRank: null, score: null, pricingTier: null, declineCategory: "BUREAU_SCORE", limitCapCents: null, hits: [] } })
    await declineThroughStaffPath(ctx)
    const call = h.decideApplication.mock.calls[0][0]
    expect(call.formData.get("action")).toBe("decline")
    expect(call.formData.get("declineCategory")).toBe("BUREAU_SCORE")
    expect(call.automation.expectedUpdatedAt).toEqual(UPDATED_AT)
    expect(w.gradeUpdates).toHaveLength(0)
  })

  it("an automatic decline the staff path refuses becomes a referral, never a decline", async () => {
    const w = stubDb()
    h.decideApplication.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Choose a decline category." }), { status: 400 }))
    const out = await declineThroughStaffPath(ctxWith({ verdict: { ...ctxWith().verdict, decision: "DECLINE", declineCategory: "POLICY" } }))
    expect(out).toMatchObject({ execution: "REFERRED" })
    expect(JSON.stringify(w.runs)).toContain("HARD_GATE_REFUSED")
    expect(JSON.stringify(w.runs)).not.toContain('"execution":"DECLINED"')
  })

  it("refers (does not decline) when the staff decline path throws, or the system user is missing", async () => {
    const w = stubDb()
    h.decideApplication.mockRejectedValueOnce(new Error("db down"))
    const verdict = { ...ctxWith().verdict, decision: "DECLINE" as const, declineCategory: "POLICY" as const }
    expect(await declineThroughStaffPath(ctxWith({ verdict }))).toMatchObject({ execution: "REFERRED" })
    expect(JSON.stringify(w.runs)).toContain("HARD_GATE_ERROR")
    stubDb({ user: null })
    expect(await declineThroughStaffPath(ctxWith({ verdict }))).toMatchObject({ execution: "REFERRED" })
    expect(h.decideApplication).toHaveBeenCalledTimes(1)
  })

  it("stands down (nothing decided) when the application changed first", async () => {
    stubDb()
    h.decideApplication.mockResolvedValueOnce(new Response(JSON.stringify({ error: "changed", applicationChanged: true }), { status: 409 }))
    expect(await declineThroughStaffPath(ctxWith({ verdict: { ...ctxWith().verdict, decision: "DECLINE", declineCategory: "POLICY" } }))).toBeNull()
    h.decideApplication.mockResolvedValueOnce(new Response(JSON.stringify({ error: "changed", applicationChanged: true }), { status: 409 }))
    expect(await approveThroughStaffPath(ctxWith(), "EFT")).toBeNull()
  })
})

describe("an approve verdict the staff path does not carry out becomes a referral", () => {
  it.each([
    ["a 422 gate refusal", async () => new Response(JSON.stringify({ error: "Bureau risk gate: score too low" }), { status: 422 }), "HARD_GATE_REFUSED", "Bureau risk gate"],
    ["an open-credit-checks 409", async () => new Response(JSON.stringify({ error: "Approval blocked: 1 credit check is open." }), { status: 409 }), "HARD_GATE_REFUSED", "credit check"],
    ["a 500", async () => new Response("{}", { status: 500 }), "HARD_GATE_REFUSED", "500"],
    ["a thrown error", async () => { throw new Error("db down") }, "HARD_GATE_ERROR", "failed"],
  ])("%s", async (_name, answer, code, note) => {
    const w = stubDb()
    h.decideApplication.mockImplementationOnce(answer)
    const out = await approveThroughStaffPath(ctxWith(), "EFT")
    expect(out).toMatchObject({ execution: "REFERRED" })
    expect(out?.note).toContain(note)
    expect(JSON.stringify(w.runs)).toContain(code)
    expect(JSON.stringify(w.runs)).toContain("RULES_PASSED")
  })

  it("never approves on its own: a refusal leaves no APPROVED run", async () => {
    const w = stubDb()
    h.decideApplication.mockResolvedValueOnce(new Response("{}", { status: 422 }))
    await approveThroughStaffPath(ctxWith(), "EFT")
    expect(JSON.stringify(w.runs)).not.toContain('"execution":"APPROVED"')
  })
})

describe("the s71 sign-off is re-read inside the decline transaction (a sign-off withdrawn or reworded between the read and the commit)", () => {
  const declineVerdict = () => ({ ...ctxWith().verdict, decision: "DECLINE" as const, declineCategory: "POLICY" as const })
  const hook = (w: { tx: unknown }) => async ({ automation }: { automation: { inTransaction: (tx: unknown) => Promise<void> } }) => { await automation.inTransaction(w.tx); return ok() }

  it("stores the wording read inside the transaction on the run, not the one read when the verdict was made", async () => {
    const w = stubDb()
    h.decideApplication.mockImplementationOnce(hook(w))
    await declineThroughStaffPath(ctxWith({ verdict: declineVerdict(), noticeText: "Older wording read earlier." }))
    expect(w.runs[0]).toMatchObject({ data: { execution: "DECLINED", noticeText: "Approved wording now." } })
    expect(String((w.tx as { $queryRaw: { mock: { calls: unknown[][] } } }).$queryRaw.mock.calls[0][0])).toContain("FOR SHARE")
  })

  it("refers instead of declining when the sign-off is gone inside the transaction: nothing is written", async () => {
    const w = stubDb({ signoff: { s71SignedOffAt: null, automatedDeclineNotice: "Draft." } })
    h.decideApplication.mockImplementationOnce(async (args: { automation: { inTransaction: (tx: unknown) => Promise<void> } }) => {
      await args.automation.inTransaction(w.tx)
      return ok()
    })
    const out = await declineThroughStaffPath(ctxWith({ verdict: declineVerdict(), noticeText: "Wording that was signed off when read." }))
    expect(out).toMatchObject({ execution: "REFERRED" })
    expect(w.runs).toHaveLength(1)
    expect(w.runs[0]).toMatchObject({ data: { execution: "REFERRED", reasonCodes: expect.arrayContaining(["S71_NOT_SIGNED_OFF"]) } })
    expect(JSON.stringify(w.runs)).not.toContain('"execution":"DECLINED"')
  })

  it("an approval does not read or depend on the sign-off", async () => {
    const w = stubDb({ signoff: { s71SignedOffAt: null, automatedDeclineNotice: null } })
    h.decideApplication.mockImplementationOnce(hook(w))
    await approveThroughStaffPath(ctxWith(), "EFT")
    expect(w.runs[0]).toMatchObject({ data: { execution: "APPROVED", noticeText: null } })
  })
})

describe("the run and the grade commit with the decision (the staff path's transaction hook)", () => {
  it("writes the AutoDecisionRun and the grade through the hook the staff path calls inside its transaction", async () => {
    const w = stubDb()
    let hooked: { runId?: string } = {}
    h.decideApplication.mockImplementationOnce(async ({ automation }: { automation: { inTransaction: (tx: unknown) => Promise<void> } }) => {
      await automation.inTransaction(w.tx)
      hooked = { runId: "set" }
      return ok()
    })
    const out = await approveThroughStaffPath(ctxWith(), "EFT")
    expect(hooked.runId).toBe("set")
    expect(out).toMatchObject({ execution: "APPROVED", runId: "run1" })
    expect(w.runs[0]).toMatchObject({ data: { execution: "APPROVED", verdict: "APPROVE", riskGrade: "A" } })
    expect(w.gradeUpdates[0]).toMatchObject({ data: { riskGrade: "A", riskGradeRank: 0, riskPricingTier: "PRIME", riskGradeVersionId: "v1" } })
  })

  it("a failure inside the hook propagates, so the staff path's transaction rolls back and the engine refers instead", async () => {
    const w = stubDb()
    ;(w.tx.autoDecisionRun as { create: ReturnType<typeof vi.fn> }).create.mockRejectedValueOnce(new Error("run insert failed"))
    h.decideApplication.mockImplementationOnce(async ({ automation }: { automation: { inTransaction: (tx: unknown) => Promise<void> } }) => {
      await automation.inTransaction(w.tx)
      return ok()
    })
    const out = await approveThroughStaffPath(ctxWith(), "EFT")
    expect(out).toMatchObject({ execution: "REFERRED" })
  })

  it("grades the application only when the verdict has a grade, and refuses a stale write when locked", async () => {
    const w = stubDb()
    await writeGrade(w.tx as never, ctxWith({ verdict: { ...ctxWith().verdict, riskGrade: null, gradeRank: null } }), true)
    expect(w.gradeUpdates).toHaveLength(0)
    ;(w.tx.loanApplication as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockImplementationOnce(async (a: unknown) => { w.gradeUpdates.push(a); return { count: 0 } })
    await expect(writeGrade(w.tx as never, ctxWith(), true)).rejects.toMatchObject({ name: "ApplicationChangedError" })
    expect(w.gradeUpdates[w.gradeUpdates.length - 1]).toMatchObject({ where: { updatedAt: UPDATED_AT, status: "UNDER_REVIEW" } })
  })

  it("a plain referral commits its grade, record, audit and run in one transaction", async () => {
    const w = stubDb()
    await refer(ctxWith(), ["R_ONE"], null)
    expect((h.prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(w.gradeUpdates).toHaveLength(1)
    expect(w.runs[0]).toMatchObject({ data: { execution: "REFERRED", submissionLatencyMs: null } })
  })
})

describe("POPIA s71: no automated decline until the lender has signed off", () => {
  const declining = () => stubDb({ versions: [version({ rules: KNOCK })] })

  it("turns a LIVE decline verdict into a referral with S71_NOT_SIGNED_OFF, and never calls the decline path", async () => {
    const w = (declining(), stubDb({ config: config({ s71SignedOffAt: null }), versions: [version({ rules: KNOCK })] }))
    const out = await run()
    expect(h.decideApplication).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: "RAN", execution: "REFERRED" })
    expect(out.status === "RAN" && out.verdict.decision).toBe("DECLINE")
    expect(JSON.stringify(w.runs)).toContain("S71_NOT_SIGNED_OFF")
  })

  it("declines through the staff path once signed off", async () => {
    declining()
    h.decideApplication.mockResolvedValueOnce(ok())
    await run()
    expect(h.decideApplication.mock.calls[0][0].formData.get("action")).toBe("decline")
  })

  it("does not let the sign-off turn a referral or approval into anything else", async () => {
    stubDb({ config: config({ s71SignedOffAt: null }) })
    h.decideApplication.mockResolvedValueOnce(ok())
    await run()
    expect(h.decideApplication.mock.calls[0][0].formData.get("action")).toBe("approve")
  })
})

describe("SHADOW rehearses: the run records the grade, the application is untouched (pricing must not move)", () => {
  it("writes a NOT_ACTED run carrying the grade, no application update, no staff-path call", async () => {
    const w = stubDb({ config: config({ mode: "SHADOW" }), versions: [version({ rules: [], scorecard: CARD })] })
    const out = await run()
    expect(out).toMatchObject({ status: "RAN", execution: "NOT_ACTED" })
    expect(w.runs[0]).toMatchObject({ data: { execution: "NOT_ACTED", riskGrade: "A", score: 120 } })
    expect(w.gradeUpdates).toHaveLength(0)
    expect(h.decideApplication).not.toHaveBeenCalled()
  })
})

describe("a stored rule set that no longer validates", () => {
  it("is skipped, audited for operations, and never acted on", async () => {
    stubDb({ versions: [version({ rules: [{ id: "BAD" }] })] })
    expect(await run()).toEqual({ status: "SKIPPED", reason: "rule_set_invalid" })
    expect(h.audits).toContainEqual(expect.objectContaining({ action: "AUTO_DECISION_RULE_SET_INVALID", entityId: "v1" }))
    expect(h.decideApplication).not.toHaveBeenCalled()
  })
})

describe("submission-to-decision latency on the run", () => {
  it("is recorded for an application the client submitted, and absent for one staff captured", async () => {
    const digital = loaded()
    digital.facts.channel = "PORTAL"
    digital.application.submittedAt = new Date("2026-10-29T07:59:50Z") as never
    const w = stubDb()
    await refer(ctxWith({ loaded: digital as never, now: new Date("2026-10-29T08:00:00Z"), startedAt: performance.now() }), ["R_ONE"], null)
    const latency = (w.runs[0] as { data: { submissionLatencyMs: number } }).data.submissionLatencyMs
    expect(latency).toBeGreaterThanOrEqual(10_000)
    expect(latency).toBeLessThan(11_000)
  })
})

describe("an application a person was asked to look at again", () => {
  it("is never decided by the engine again, in any mode (breaker A, fix review)", async () => {
    for (const mode of ["LIVE", "SHADOW"]) {
      const w = stubDb({ config: config({ mode }) })
      const reopened = loaded()
      ;(reopened.application as Record<string, unknown>).humanReviewRequestedAt = new Date("2026-10-29T09:00:00Z")
      h.loadDecisionFacts.mockResolvedValueOnce(reopened)
      expect(await run()).toEqual({ status: "SKIPPED", reason: "human_review_requested" })
      expect(h.decideApplication).not.toHaveBeenCalled()
      expect(w.runs).toHaveLength(0)
    }
  })
})

describe("the client notice is the wording approved when the engine declined", () => {
  it("is stored on a DECLINED run, and on no other run", async () => {
    const NOTICE = "This decision was made by automated means; you may ask for a person to review it."
    const w = stubDb({ signoff: { s71SignedOffAt: new Date("2026-10-01T00:00:00Z"), automatedDeclineNotice: NOTICE } })
    h.decideApplication.mockImplementationOnce(async ({ automation }: { automation: { inTransaction: (tx: unknown) => Promise<void> } }) => {
      await automation.inTransaction(w.tx)
      return ok()
    })
    const verdict = { ...ctxWith().verdict, decision: "DECLINE" as const, declineCategory: "POLICY" as const }
    await declineThroughStaffPath(ctxWith({ verdict, noticeText: NOTICE }))
    expect(w.runs[0]).toMatchObject({ data: { execution: "DECLINED", noticeText: NOTICE } })
    await refer(ctxWith({ noticeText: NOTICE }), ["R_ONE"], null)
    expect(w.runs[1]).toMatchObject({ data: { execution: "REFERRED", noticeText: null } })
  })

  it("the run carries the current wording only once the lender has signed off", async () => {
    stubDb({ config: config({ automatedDeclineNotice: "Draft wording not yet signed off by anyone.", s71SignedOffAt: null }), versions: [version({ rules: KNOCK })] })
    const out = await run()
    expect(out).toMatchObject({ execution: "REFERRED" })
  })
})

describe("SHADOW on a digital submission rehearses without moving the workflow (no paid bureau pull)", () => {
  const submitted = (bureauCheckId: string | null) => {
    const l = loaded()
    l.application.status = "SUBMITTED"
    l.bureauCheckId = bureauCheckId as never
    return l
  }
  const shadowRun = () => runAutoDecision({ tenantId: "t", applicationId: "app-1", trigger: "DIGITAL_SUBMISSION", now: new Date("2026-10-29T08:00:00Z") })

  it("computes a verdict for a SUBMITTED application from bureau data already on file, writing only the run", async () => {
    const w = stubDb({ config: config({ mode: "SHADOW", channels: ["STAFF"] }), versions: [version({ rules: [], scorecard: CARD })] })
    h.loadDecisionFacts.mockResolvedValueOnce(submitted("b1"))
    const out = await shadowRun()
    expect(out).toMatchObject({ status: "RAN", execution: "NOT_ACTED" })
    expect(h.loadDecisionFacts.mock.calls[0][4]).toMatchObject({ existingBureauOnly: true })
    expect(w.runs[0]).toMatchObject({ data: { mode: "SHADOW", trigger: "DIGITAL_SUBMISSION", execution: "NOT_ACTED", riskGrade: "A" } })
    expect(w.gradeUpdates).toHaveLength(0)
    expect(h.decideApplication).not.toHaveBeenCalled()
  })

  it("records a no_bureau shadow run when there is no bureau data to use, never a score", async () => {
    const w = stubDb({ config: config({ mode: "SHADOW", channels: ["STAFF"] }), versions: [version({ rules: [], scorecard: CARD })] })
    h.loadDecisionFacts.mockResolvedValueOnce(submitted(null))
    const out = await shadowRun()
    expect(out).toMatchObject({ status: "RAN", execution: "NOT_ACTED" })
    expect(w.runs[0]).toMatchObject({ data: { verdict: "REFER", reasonCodes: ["NO_BUREAU"], riskGrade: null, score: null } })
  })

  it("a LIVE engine does not decide a SUBMITTED application through this door, and a manual run never does", async () => {
    stubDb({ config: config({ mode: "LIVE" }) })
    h.loadDecisionFacts.mockResolvedValueOnce(submitted("b1"))
    expect(await shadowRun()).toEqual({ status: "SKIPPED", reason: "not_under_review" })
    stubDb({ config: config({ mode: "SHADOW" }) })
    h.loadDecisionFacts.mockResolvedValueOnce(submitted("b1"))
    expect(await runAutoDecision({ tenantId: "t", applicationId: "app-1", trigger: "MANUAL" })).toEqual({ status: "SKIPPED", reason: "not_under_review" })
  })
})
