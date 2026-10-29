/**
 * Real-Postgres proof of the automatic decision engine, through the real
 * staff approval path, under a role row-level security binds (neither
 * superuser nor BYPASSRLS) and through the production client. The rule set and
 * the engine settings arrive the only way they can: drafted, submitted and
 * approved by two different staff users (lib/maker-checker/).
 *
 * Every approval gate runs for real against fixture rows, as in
 * app/api/applications/[id]/decide/decision-log.integration.test.ts (whose
 * borrower fixture this follows). Mocked: `@/lib/prisma` (replaced by the
 * RLS-bound client), `@/lib/auth` (NextAuth does not load under vitest) and
 * `@/lib/notifications` (no outbound email or WhatsApp).
 *
 *   RUN_DECISIONING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/decisioning/auto-decision.integration.test.ts
 */
import { appendFileSync } from "node:fs"
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null }))

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, {
    get(_target, key) {
      if (!holder.app) throw new Error("the RLS-bound app client is created in beforeAll")
      const value: unknown = Reflect.get(holder.app, key)
      return typeof value === "function" ? value.bind(holder.app) : value
    },
  })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
const notify = vi.hoisted(() => vi.fn(async () => undefined))
// The bureau provider is not reachable from a test: a review's enquiry writes the check this suite hands it.
const bureauStub = vi.hoisted(() => ({ run: null as null | ((a: { applicationId: string; clientId: string; reviewGeneration: string }) => Promise<string>) }))
vi.mock("@/lib/compliance/bureau-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance/bureau-review")>()),
  runBureauReviewCheck: (a: { applicationId: string; clientId: string; reviewGeneration: string }) => bureauStub.run!(a),
}))
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications")>()),
  triggerNotification: notify,
}))

import { createSubmissionAffordabilitySnapshot, withAffordabilitySnapshot } from "@/lib/affordability/snapshot"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { listAutomatedDeclines } from "./automated-declines"
import { runAutoDecision } from "./auto-decision"
import { markDigitalDecisionDue, runDigitalDue, sweepDigitalDecisions } from "./digital-due"
import { reviewDigitalSubmission } from "./digital-submission"
import { HumanReviewError, requestHumanReview } from "./human-review"
import { ENGINE_CONFIG_KIND, RULE_SET_KIND } from "./change-payloads"
import { automatedDeclineNoticeFor } from "./notice"
import { getRiskGrade } from "./risk-grade"
import { simulateRuleSet } from "./simulate"
import { inChallengerGroup } from "./select-version"

const RUN = process.env.RUN_DECISIONING_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const ROLE = "cf_decisioning_it"
const t = randomUUID().replaceAll("-", "").slice(0, 12)
const ids = { tenant: `decisioning-${t}`, officer: `dec-officer-${t}`, maker: `dec-maker-${t}`, checker: `dec-checker-${t}`, product: `dec-product-${t}` }
const db = new PrismaClient()
let app: ReturnType<typeof createAppPrismaClient> | undefined
const latencies: number[] = []

const product = {
  productType: "MICRO" as const, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL" as const,
  initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900,
}
const expenses = { housing: 400_000, transport: 150_000, food: 150_000, insurance: 50_000, medical: 50_000 }
const longAgo = new Date(Date.now() - 2 * 365 * 86_400_000)
const clientOf = (applicationId: string) => `${applicationId}-client`
const maker = { id: ids.maker, email: `${ids.maker}@test.invalid`, role: "ADMIN", totpVerified: true }
const checker = { id: ids.checker, email: `${ids.checker}@test.invalid`, role: "ADMIN", totpVerified: true }

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`)
  return password
}

function roleUrl(password: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

/** A borrower with verified KYC and an UNDER_REVIEW application with intact evidence and a current bureau check (the decide route's fixture). */
async function underReview(id: string, opts: { bureauScore?: number; amount?: number; clearFlags?: boolean; submittedAgoMs?: number } = {}) {
  const terms = { appliedAmount: opts.amount ?? 500_000, appliedTermDays: 30 }
  const clientId = clientOf(id)
  await db.client.create({
    data: {
      id: clientId, tenantId: ids.tenant, reference: `CLI-${id}`, idNumber: syntheticSaIdNumber(), firstName: "Synthetic", lastName: "Borrower",
      email: `${id}@test.invalid`, phone: "+27820000000", grossMonthlyIncome: 2_200_000, monthlyIncome: 2_000_000, monthlyExpenses: 800_000,
      dateOfBirth: new Date("1988-03-02T00:00:00Z"), employmentStatus: "EMPLOYED", expenseBreakdown: { create: expenses },
    },
  })
  for (const docType of ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const) {
    await db.clientDocument.create({
      data: {
        tenantId: ids.tenant, clientId, docType, fileUrl: `/synthetic/${docType}`, fileName: `${docType}.pdf`, fileSize: 1024,
        mimeType: "application/pdf", contentSha256: randomBytes(32).toString("hex"), extractionStatus: "skipped",
        verified: true, verifiedAt: longAgo, verifiedById: ids.officer, createdAt: longAgo, uploadedByType: "staff",
      },
    })
  }
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, include: { expenseBreakdown: true } })
  const submittedAt = new Date(Date.now() - (opts.submittedAgoMs ?? 60 * 60_000))
  const submission = createSubmissionAffordabilitySnapshot({
    capturedAt: submittedAt, capturedById: ids.officer, client, applicationDebts: [], clientDebts: [],
    application: { ...terms, productId: ids.product, initiationFeePayment: "DEFERRED" }, product,
  })
  const noOffer = { version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION, election: "DECLINED" as const, principalCents: terms.appliedAmount, termDays: terms.appliedTermDays }
  await db.loanApplication.create({
    data: {
      id, tenantId: ids.tenant, reference: `APP-${id}`, clientId, productId: ids.product, ...terms,
      initiationFeePayment: "DEFERRED", status: "UNDER_REVIEW", submittedAt, assignedToId: ids.officer,
      bureauReviewGeneration: randomUUID(), existingDebtObligations: [],
      affordabilityResult: withAffordabilitySnapshot(null, submission) as object,
      clientAffordabilityDeclaredAt: submittedAt,
      recklessLendingAssessed: true, recklessLendingAssessedAt: submittedAt, recklessLendingAssessedById: ids.officer,
      creditLifeElection: "DECLINED", creditLifeMonthlyPremiumCents: 0, creditLifeDisclosureVersion: noOffer.version,
      creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256(noOffer),
      creditLifeDisclosureAcknowledgedAt: submittedAt, creditLifeDisclosureAcknowledgedBy: clientId,
    },
  })
  const application = await db.loanApplication.findUniqueOrThrow({ where: { id } })
  await db.creditBureauCheck.create({
    data: {
      tenantId: ids.tenant, clientId, applicationId: id, reviewGeneration: application.bureauReviewGeneration,
      subjectFingerprint: bureauSubjectFingerprint(client), provider: "experian", score: opts.bureauScore ?? 640, riskGrade: "LOW",
      adverseInfo: [], declineReasons: [], obligations: { totalMonthly: 0 }, ok: true,
    },
  })
  if (opts.clearFlags !== false) {
    // The real recompute raises its findings (no statement or payslip in the window); an officer clears each with a reason.
    await runWithTenant(ids.tenant, () => recomputeApplicationFlags(ids.tenant, id, { userId: ids.officer }))
    await db.applicationCheckFlag.updateMany({
      where: { tenantId: ids.tenant, applicationId: id, status: "OPEN" },
      data: { status: "CLEARED", clearedById: ids.officer, clearedAt: new Date(), clearReason: "Synthetic: income verified by other means." },
    })
  }
}

const RULES = [
  { id: "bureau-low", name: "Bureau score below 560", outcome: "KNOCK_OUT", reasonCode: "BUREAU_SCORE_LOW", declineCategory: "BUREAU_SCORE", when: { field: "bureauScore", op: "lt", value: 560 } },
  { id: "large", name: "Large amount", outcome: "REFER", reasonCode: "LARGE_AMOUNT", when: { field: "requestedAmountCents", op: "gt", value: 600_000 } },
]
const CARD = {
  baseScore: 0,
  characteristics: [{ field: "bureauScore", missingPoints: 0, bins: [{ max: 600, points: 40 }, { min: 600, points: 120 }] }],
  bands: [{ minScore: 100, grade: "A", action: "ALLOW", pricingTier: "PRIME" }, { minScore: 0, grade: "B", action: "ALLOW", pricingTier: "STANDARD" }],
}

async function approveChange(kind: string, title: string, payload: object): Promise<string> {
  const draft = await createDraft({ tenantId: ids.tenant, actor: maker, kind, title, payload })
  await submit({ tenantId: ids.tenant, actor: maker, id: draft.id })
  await approve({ tenantId: ids.tenant, actor: checker, id: draft.id })
  return draft.id
}

const NOTICE = "This decision was made by automated means. You may make representations and ask for a person to review it."
// What the lender has signed off so far: every settings change carries it forward.
const signOff = { s71SignOff: false, automatedDeclineNotice: null as string | null }
const engine = (over: Record<string, unknown> = {}) => ({
  mode: "LIVE", channels: ["STAFF"], productIds: [ids.product], repaymentMethod: "EFT",
  challengerVersionId: null, challengerPercent: 0, ...signOff, ...over,
})
const systemUser = () => db.user.findFirstOrThrow({ where: { tenantId: ids.tenant, isSystem: true } })
const run = (applicationId: string) => runAutoDecision({ tenantId: ids.tenant, applicationId, trigger: "MANUAL" })
const ran = async (applicationId: string) => {
  const outcome = await run(applicationId)
  if (outcome.status !== "RAN") throw new Error(`skipped: ${outcome.reason}`)
  latencies.push(outcome.latencyMs)
  return outcome
}
const statusOf = async (id: string) => (await db.loanApplication.findUniqueOrThrow({ where: { id } })).status

suite("automatic decisions through the staff approval path (real Postgres, row-level security)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: ids.tenant, slug: ids.tenant, name: "Decisioning IT" } })
    await db.tenantConfig.create({ data: { tenantId: ids.tenant, bureauMinScore: 580 } })
    for (const [id, role] of [[ids.officer, "LOAN_ADMIN"], [ids.maker, "ADMIN"], [ids.checker, "ADMIN"]] as const) {
      await db.user.create({ data: { id, tenantId: ids.tenant, email: `${id}@test.invalid`, password: "not-a-real-login", name: id, role } })
    }
    await db.loanProduct.create({
      data: { id: ids.product, tenantId: ids.tenant, code: `DC-${t}`, name: "Decisioning micro", minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, ...product },
    })
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(roleUrl(await createAppRole()))
    holder.app = app
  }, 120_000)

  afterAll(async () => {
    if (process.env.LATENCY_REPORT && latencies.length > 0) appendFileSync(process.env.LATENCY_REPORT, `${JSON.stringify(latencies)}\n`)
    vi.unstubAllEnvs()
    holder.app = null
    await app?.$disconnect()
    const tenantId = ids.tenant
    // Append-only tables: the replica role skips their triggers, as the decide route's suite does.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.autoDecisionRun.deleteMany({ where: { tenantId } }),
      db.autoDecisionDue.deleteMany({ where: { tenantId } }),
      db.creditDecisionRecord.deleteMany({ where: { tenantId } }),
      db.auditLog.deleteMany({ where: { tenantId } }),
      db.webhookEvent.deleteMany({ where: { tenantId } }),
      db.applicationCheckFlag.deleteMany({ where: { tenantId } }),
      db.creditBureauCheck.deleteMany({ where: { tenantId } }),
      db.loanApplication.deleteMany({ where: { tenantId } }),
      db.clientDocument.deleteMany({ where: { tenantId } }),
      db.clientExpenseBreakdown.deleteMany({ where: { client: { tenantId } } }),
      db.client.deleteMany({ where: { tenantId } }),
      db.decisionEngineConfig.deleteMany({ where: { tenantId } }),
      db.decisionRuleSetVersion.deleteMany({ where: { tenantId } }),
      db.changeRequest.deleteMany({ where: { tenantId } }),
      db.loanProduct.deleteMany({ where: { tenantId } }),
      db.user.deleteMany({ where: { tenantId } }),
      db.tenantConfig.deleteMany({ where: { tenantId } }),
      db.tenant.deleteMany({ where: { id: tenantId } }),
    ])
    if ((await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`).length > 0) {
      await db.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`)
      await db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`)
    }
    await db.$disconnect()
  }, 60_000)

  it("runs as a role row-level security binds (otherwise it proves nothing)", async () => {
    const [me] = await app!.$queryRaw<{ su: boolean; bypass: boolean }[]>`SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
  })

  it("does nothing until the lender approves engine settings: the default is off", async () => {
    await underReview("dec-off", { clearFlags: false })
    expect(await run("dec-off")).toEqual({ status: "SKIPPED", reason: "engine_off" })
    expect(await statusOf("dec-off")).toBe("UNDER_REVIEW")
    expect(await db.autoDecisionRun.count({ where: { tenantId: ids.tenant } })).toBe(0)
  })

  it("will not go live on a product with no approved rule set", async () => {
    const draft = await createDraft({ tenantId: ids.tenant, actor: maker, kind: ENGINE_CONFIG_KIND, title: "Go live", payload: engine() })
    await expect(submit({ tenantId: ids.tenant, actor: maker, id: draft.id })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
  })

  it("approves a good applicant through every staff gate and books it as a system decision", async () => {
    await approveChange(RULE_SET_KIND, "Baseline rules", { productId: null, name: "Baseline", effectiveFrom: "2026-01-01", challengerOnly: false, rules: RULES, scorecard: CARD })
    await approveChange(ENGINE_CONFIG_KIND, "Go live", engine())
    await underReview("dec-approve", { bureauScore: 640 })
    const outcome = await ran("dec-approve")
    expect(outcome).toMatchObject({ execution: "APPROVED", role: "CHAMPION", ruleSet: "ALL:v1" })
    expect(outcome.verdict).toMatchObject({ decision: "APPROVE", reasonCodes: ["RULES_PASSED"], riskGrade: "A" })
    const application = await db.loanApplication.findUniqueOrThrow({ where: { id: "dec-approve" } })
    const system = await systemUser()
    // Booked under the lender's system user (no person's identity), graded in the same transaction.
    expect(application).toMatchObject({ status: "APPROVED", approvedById: system.id, riskGrade: "A", riskScore: 120, riskGradeRank: 0, riskPricingTier: "PRIME" })
    expect(application.riskGradeVersionId).toBe(outcome.status === "RAN" ? (await db.autoDecisionRun.findFirstOrThrow({ where: { id: outcome.runId } })).ruleSetVersionId : "")
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: ids.tenant, entityId: "dec-approve", action: "LOAN_APPROVED" } })
    expect(audit.userId).toBe(system.id)
    expect(audit.newValue).toMatchObject({ automated: true, ruleVersion: "ALL:v1", reasonCodes: ["RULES_PASSED"], riskGrade: "A" })
    const records = await db.creditDecisionRecord.findMany({ where: { tenantId: ids.tenant, applicationId: "dec-approve" }, orderBy: { kind: "asc" } })
    expect(records.map((r) => [r.kind, r.decision, r.actorType, r.actorUserId])).toEqual([["CREDIT_DECISION", "APPROVE", "SYSTEM", null], ["OFFER", "APPROVED_TERMS", "SYSTEM", null]])
    expect(records[0].inputsSnapshot).toMatchObject({ automated: { ruleVersion: "ALL:v1", riskGrade: "A" } })
    const runRow = await db.autoDecisionRun.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-approve" } })
    expect(runRow).toMatchObject({ verdict: "APPROVE", execution: "APPROVED", mode: "LIVE", role: "CHAMPION", riskGrade: "A", trigger: "MANUAL" })
    expect(await getRiskGrade(app as never, ids.tenant, "dec-approve")).toMatchObject({ grade: "A", score: 120, pricingTier: "PRIME", rank: 0, ruleSetVersionId: runRow.ruleSetVersionId })
    expect(runRow.submissionLatencyMs).toBeNull()
  })

  it("holds an automated decline until the lender has signed off (POPIA s71): the verdict is a referral, nothing is declined", async () => {
    await underReview("dec-decline", { bureauScore: 520, clearFlags: false })
    const outcome = await ran("dec-decline")
    expect(outcome.verdict).toMatchObject({ decision: "DECLINE", reasonCodes: ["BUREAU_SCORE_LOW"], declineCategory: "BUREAU_SCORE" })
    expect(outcome).toMatchObject({ execution: "REFERRED" })
    expect(await statusOf("dec-decline")).toBe("UNDER_REVIEW")
    const runRow = await db.autoDecisionRun.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-decline" } })
    expect(runRow).toMatchObject({ verdict: "DECLINE", execution: "REFERRED" })
    expect(runRow.reasonCodes).toEqual(["BUREAU_SCORE_LOW", "S71_NOT_SIGNED_OFF"])
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ event: "application_declined", loanId: "dec-decline" }))
  })

  it("declines through the staff decline path once signed off: a system decision flagged for the s71 review, with the approved client wording and notice", async () => {
    signOff.s71SignOff = true
    signOff.automatedDeclineNotice = NOTICE
    await approveChange(ENGINE_CONFIG_KIND, "Sign off automated declines", engine())
    const config = await db.decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: ids.tenant } })
    expect(config).toMatchObject({ s71SignedOffById: ids.checker, automatedDeclineNotice: NOTICE })
    const outcome = await ran("dec-decline")
    expect(outcome).toMatchObject({ execution: "DECLINED" })
    const system = await systemUser()
    const application = await db.loanApplication.findUniqueOrThrow({ where: { id: "dec-decline" } })
    expect(application).toMatchObject({ status: "DECLINED", approvedById: system.id, declineCategory: "BUREAU_SCORE", decisionReason: "Your credit record at the credit bureau does not meet our lending criteria.", riskGrade: "B" })
    expect(application.declineInternalNote).toContain("BUREAU_SCORE_LOW")
    const records = await db.creditDecisionRecord.findMany({ where: { tenantId: ids.tenant, applicationId: "dec-decline", decision: "DECLINE" } })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ recommendation: "BLOCK", actorType: "SYSTEM", actorUserId: null, s71ReviewRequired: true })
    expect(records[0].inputsSnapshot).toMatchObject({ declineCategory: "BUREAU_SCORE", automated: { reasonCodes: ["BUREAU_SCORE_LOW"] } })
    expect(await db.auditLog.count({ where: { tenantId: ids.tenant, entityId: "dec-decline", action: "LOAN_DECLINED", userId: system.id } })).toBe(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: "application_declined", loanId: "dec-decline" }))
    const runRow = await db.autoDecisionRun.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-decline", execution: "DECLINED" } })
    expect(runRow.id).toBe(outcome.status === "RAN" ? outcome.runId : "")
    // The wording in force at the decline is stored on the run, and is what the client is sent.
    expect(await automatedDeclineNoticeFor(ids.tenant, "dec-decline")).toBe(NOTICE)
    expect(runRow.noticeText).toBe(NOTICE)
    expect(await automatedDeclineNoticeFor(ids.tenant, "dec-approve")).toBeNull()
    // A later edit of the wording does not change what this client was told.
    await db.$executeRawUnsafe(`ALTER TABLE "DecisionEngineConfig" DISABLE TRIGGER "DecisionEngineConfig_guard"`)
    await db.$executeRawUnsafe(`UPDATE "DecisionEngineConfig" SET "automatedDeclineNotice" = 'A different paragraph the lender approved later on.' WHERE "tenantId" = '${ids.tenant}'`)
    await db.$executeRawUnsafe(`ALTER TABLE "DecisionEngineConfig" ENABLE TRIGGER "DecisionEngineConfig_guard"`)
    expect(await automatedDeclineNoticeFor(ids.tenant, "dec-decline")).toBe(NOTICE)
    await db.$executeRawUnsafe(`ALTER TABLE "DecisionEngineConfig" DISABLE TRIGGER "DecisionEngineConfig_guard"`)
    await db.$executeRawUnsafe(`UPDATE "DecisionEngineConfig" SET "automatedDeclineNotice" = '${NOTICE}' WHERE "tenantId" = '${ids.tenant}'`)
    await db.$executeRawUnsafe(`ALTER TABLE "DecisionEngineConfig" ENABLE TRIGGER "DecisionEngineConfig_guard"`)
  })

  it("a client's request for a person to look again reopens an automated decline to UNDER_REVIEW, audited and recorded; nothing else can be reopened", async () => {
    const officer = { id: ids.officer, email: `${ids.officer}@test.invalid`, role: "LOAN_ADMIN" }
    const queue = await listAutomatedDeclines(ids.tenant)
    expect(queue.rows.find((r) => r.applicationId === "dec-decline")).toMatchObject({ status: "DECLINED", reasonCodes: ["BUREAU_SCORE_LOW"], noticeSent: true })
    await expect(requestHumanReview({ tenantId: ids.tenant, applicationId: "dec-approve", actor: officer, reason: "Client asked for a review" })).rejects.toBeInstanceOf(HumanReviewError)
    await requestHumanReview({ tenantId: ids.tenant, applicationId: "dec-decline", actor: officer, reason: "Client asked for a person to review the decision" })
    expect(await db.loanApplication.findUniqueOrThrow({ where: { id: "dec-decline" } })).toMatchObject({ status: "UNDER_REVIEW", approvedById: null, declineCategory: null, decisionReason: null })
    expect(await db.auditLog.count({ where: { tenantId: ids.tenant, entityId: "dec-decline", action: "AUTO_DECISION_HUMAN_REVIEW_REQUESTED", userId: ids.officer } })).toBe(1)
    const record = await db.creditDecisionRecord.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-decline", decision: "RETURN_TO_REVIEW" } })
    expect(record).toMatchObject({ actorType: "STAFF", actorUserId: ids.officer })
    await expect(requestHumanReview({ tenantId: ids.tenant, applicationId: "dec-decline", actor: officer, reason: "Client asked again for a review" })).rejects.toMatchObject({ code: "NOT_DECLINED" })
    // A fresh review cycle, as a return to review: no reckless-lending attestation or bureau generation carries over.
    const reopened = await db.loanApplication.findUniqueOrThrow({ where: { id: "dec-decline" } })
    expect(reopened).toMatchObject({ recklessLendingAssessed: false, recklessLendingAssessedById: null })
    expect(reopened.humanReviewRequestedAt).not.toBeNull()
    // The engine never decides it again, in either mode.
    expect(await run("dec-decline")).toEqual({ status: "SKIPPED", reason: "human_review_requested" })
  })

  it("a person's decline after an engine decline is a person's decision: no automated notice, no human-review reopen, not in the queue as automated", async () => {
    const officer = { id: ids.officer, email: `${ids.officer}@test.invalid`, role: "LOAN_ADMIN" }
    // The reopened application is declined by a person (the officer), as staff would.
    await db.loanApplication.update({ where: { id: "dec-decline" }, data: { status: "DECLINED", approvedById: ids.officer, approvedAt: new Date(), decisionReason: "Declined by a person", declineCategory: "AFFORDABILITY" } })
    expect(await automatedDeclineNoticeFor(ids.tenant, "dec-decline")).toBeNull()
    await expect(requestHumanReview({ tenantId: ids.tenant, applicationId: "dec-decline", actor: officer, reason: "Client asked for a review again" })).rejects.toMatchObject({ code: "NOT_AUTOMATED" })
  })

  it("refers when a refer rule fires: the application stays with staff, and the code says why", async () => {
    await underReview("dec-refer", { amount: 700_000, clearFlags: false })
    const outcome = await ran("dec-refer")
    expect(outcome).toMatchObject({ execution: "REFERRED" })
    expect(outcome.verdict).toMatchObject({ decision: "REFER", reasonCodes: ["LARGE_AMOUNT"] })
    expect(await statusOf("dec-refer")).toBe("UNDER_REVIEW")
    const record = await db.creditDecisionRecord.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-refer" } })
    expect(record).toMatchObject({ decision: "REFER", recommendation: "REFER", actorType: "SYSTEM", s71ReviewRequired: false })
  })

  it("never bypasses a hard gate: an approve verdict the staff path refuses becomes a referral", async () => {
    // The credit checks raise findings no officer has cleared: the approval path refuses (409), as it would a person.
    await underReview("dec-gate", { bureauScore: 640, clearFlags: false })
    const outcome = await ran("dec-gate")
    expect(outcome.verdict.decision).toBe("APPROVE")
    expect(outcome).toMatchObject({ execution: "REFERRED" })
    expect(outcome.note).toMatch(/credit check/i)
    expect(await statusOf("dec-gate")).toBe("UNDER_REVIEW")
    const runRow = await db.autoDecisionRun.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-gate" } })
    expect(runRow.reasonCodes).toEqual(["RULES_PASSED", "HARD_GATE_REFUSED"])
    expect(await db.loanApplication.findUniqueOrThrow({ where: { id: "dec-gate" } })).toMatchObject({ approvedById: null })
  })

  it("skips an application whose channel or product the lender has not enabled, and one no longer under review", async () => {
    await approveChange(ENGINE_CONFIG_KIND, "Portal only", engine({ channels: ["PORTAL"] }))
    expect(await run("dec-gate")).toEqual({ status: "SKIPPED", reason: "channel_not_enabled" })
    await approveChange(ENGINE_CONFIG_KIND, "Staff channel again", engine())
    expect(await run("dec-approve")).toEqual({ status: "SKIPPED", reason: "not_under_review" })
  })

  it("shadow mode grades and records, and takes no decision; the challenger decides its share and the run says which version", async () => {
    const challengerCr = await approveChange(RULE_SET_KIND, "Challenger", {
      productId: null, name: "Stricter", effectiveFrom: "2026-01-01", challengerOnly: true,
      rules: [{ id: "bureau-mid", name: "Bureau below 700", outcome: "KNOCK_OUT", reasonCode: "BUREAU_BELOW_700", declineCategory: "BUREAU_SCORE", when: { field: "bureauScore", op: "lt", value: 700 } }], scorecard: CARD,
    })
    const challenger = await db.decisionRuleSetVersion.findFirstOrThrow({ where: { tenantId: ids.tenant, changeRequestId: challengerCr } })
    expect(challenger).toMatchObject({ version: 2, challengerOnly: true })
    await approveChange(ENGINE_CONFIG_KIND, "Shadow with challenger", engine({ mode: "SHADOW", challengerVersionId: challenger.id, challengerPercent: 50 }))
    const pick = (inGroup: boolean, n: number) => Array.from({ length: 400 }, (_, i) => `dec-sh-${inGroup ? "c" : "m"}${i}`).filter((id) => inChallengerGroup(id, challenger.id, 50) === inGroup).slice(0, n)
    const [champId] = pick(false, 1)
    const [challId] = pick(true, 1)
    await underReview(champId, { bureauScore: 640, clearFlags: false })
    await underReview(challId, { bureauScore: 640, clearFlags: false })
    const champ = await ran(champId)
    const chall = await ran(challId)
    expect(champ).toMatchObject({ role: "CHAMPION", ruleSet: "ALL:v1", execution: "NOT_ACTED" })
    expect(champ.verdict.decision).toBe("APPROVE")
    expect(chall).toMatchObject({ role: "CHALLENGER", ruleSet: "ALL:v2", execution: "NOT_ACTED" })
    expect(chall.verdict).toMatchObject({ decision: "DECLINE", reasonCodes: ["BUREAU_BELOW_700"] })
    for (const id of [champId, challId]) {
      expect(await statusOf(id)).toBe("UNDER_REVIEW")
      expect(await db.creditDecisionRecord.count({ where: { tenantId: ids.tenant, applicationId: id } })).toBe(0)
      // A rehearsal never moves the application: the grade is on the run alone.
      expect(await db.loanApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ riskGrade: null, riskGradeVersionId: null, riskPricingTier: null })
    }
    const runs = await db.autoDecisionRun.findMany({ where: { tenantId: ids.tenant, applicationId: { in: [champId, challId] } } })
    expect(runs.map((r) => [r.applicationId === champId ? "champ" : "chall", r.role, r.mode, r.execution, r.ruleSetVersionId === challenger.id, r.riskGrade]).sort()).toEqual([
      ["chall", "CHALLENGER", "SHADOW", "NOT_ACTED", true, "A"], ["champ", "CHAMPION", "SHADOW", "NOT_ACTED", false, "A"],
    ])
  })

  it("simulates a draft over real applications against the live version and what staff decided, and writes nothing", async () => {
    const before = async () => ({
      runs: await db.autoDecisionRun.count({ where: { tenantId: ids.tenant } }),
      records: await db.creditDecisionRecord.count({ where: { tenantId: ids.tenant } }),
      audits: await db.auditLog.count({ where: { tenantId: ids.tenant } }),
      statuses: (await db.loanApplication.findMany({ where: { tenantId: ids.tenant }, select: { id: true, status: true, updatedAt: true }, orderBy: { id: "asc" } })).map((a) => `${a.id}:${a.status}:${a.updatedAt.getTime()}`),
    })
    const snapshot = await before()
    const report = await simulateRuleSet({
      tenantId: ids.tenant,
      candidate: { productId: null, scorecard: CARD, rules: [{ id: "bureau-650", name: "Bureau below 650", outcome: "KNOCK_OUT", reasonCode: "BUREAU_BELOW_650", declineCategory: "BUREAU_SCORE", when: { field: "bureauScore", op: "lt", value: 650 } }] },
    })
    expect(report.indicative).toBe(true)
    expect(report.snapshotBacked).toBeGreaterThan(0)
    expect(report.liveRuleSet).toBe("ALL:v1")
    expect(report.sampled).toBeGreaterThanOrEqual(7)
    // The reopened application has a fresh review cycle and no bureau check of it yet.
    expect(report.withBureau).toBe(report.sampled - 1)
    // Live (v1): the 640s approve, 520 declines, the 700k amount refers. Candidate: everything under 650 declines.
    // (the reopened application has no bureau check of its new cycle, so it no longer declines)
    expect(report.live).toMatchObject({ DECLINE: 0, REFER: 1 })
    expect(report.candidate.DECLINE).toBeGreaterThan(report.live!.DECLINE)
    expect(report.changes).toContainEqual(expect.objectContaining({ from: "APPROVE", to: "DECLINE" }))
    expect(report.ruleHits).toEqual([expect.objectContaining({ ruleId: "bureau-650", hits: report.candidate.DECLINE })])
    // The engine's own approvals and declines are not staff decisions: nothing here was decided by a person.
    expect(report.againstStaff).toEqual({ approvedByStaff: 0, candidateWouldDecline: 0, declinedByStaff: 0, candidateWouldApprove: 0 })
    expect(report.byGrade).toMatchObject({ A: expect.any(Number) })
    expect(await before()).toEqual(snapshot)
  })

  it("reviews and decides a digitally submitted application after the response, as the system user, and records submission-to-decision latency", async () => {
    await approveChange(ENGINE_CONFIG_KIND, "Staff only again", engine({ channels: ["STAFF"] }))
    await underReview("dec-digital", { bureauScore: 640, submittedAgoMs: 5_000 })
    // Back to SUBMITTED, as a client's application arrives, with the audit row the portal writes.
    await db.loanApplication.update({ where: { id: "dec-digital" }, data: { status: "SUBMITTED" } })
    await db.auditLog.create({ data: { tenantId: ids.tenant, action: "APPLICATION_SUBMITTED_BY_CLIENT", entity: "LoanApplication", entityId: "dec-digital", newValue: {} } })
    expect(await reviewDigitalSubmission({ tenantId: ids.tenant, applicationId: "dec-digital" })).toEqual({ status: "SKIPPED", reason: "channel_not_enabled" })
    expect(await statusOf("dec-digital")).toBe("SUBMITTED")

    await approveChange(ENGINE_CONFIG_KIND, "Digital channel on", engine({ channels: ["PORTAL", "STAFF"] }))
    bureauStub.run = async ({ applicationId, clientId, reviewGeneration }) => {
      const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
      await db.creditBureauCheck.create({ data: { tenantId: ids.tenant, clientId, applicationId, reviewGeneration, subjectFingerprint: bureauSubjectFingerprint(client), provider: "experian", score: 640, riskGrade: "LOW", adverseInfo: [], declineReasons: [], obligations: { totalMonthly: 0 }, ok: true } })
      return "completed"
    }
    expect(await reviewDigitalSubmission({ tenantId: ids.tenant, applicationId: "dec-digital" })).toEqual({ status: "REVIEWED" })
    const application = await db.loanApplication.findUniqueOrThrow({ where: { id: "dec-digital" } })
    const runRow = await db.autoDecisionRun.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-digital" } })
    expect(application, JSON.stringify([runRow.execution, runRow.executionNote, runRow.reasonCodes])).toMatchObject({ status: "APPROVED", approvedById: (await systemUser()).id, riskGrade: "A" })
    expect(runRow).toMatchObject({ trigger: "DIGITAL_SUBMISSION", execution: "APPROVED", mode: "LIVE" })
    expect(runRow.submissionLatencyMs).toBeGreaterThanOrEqual(5_000)
    expect(runRow.submissionLatencyMs).toBeLessThan(60_000)
    latencies.push(runRow.submissionLatencyMs ?? 0)
    // Not submitted any more: nothing to review.
    expect(await reviewDigitalSubmission({ tenantId: ids.tenant, applicationId: "dec-digital" })).toEqual({ status: "SKIPPED", reason: "application_not_submitted" })
  })

  it("SHADOW on a digital submission rehearses only: status, assignment and bureau data are untouched, and no review is started", async () => {
    await approveChange(ENGINE_CONFIG_KIND, "Shadow, digital", engine({ mode: "SHADOW", channels: ["PORTAL", "STAFF"], ...signOff }))
    await underReview("dec-shadow-digital", { bureauScore: 640 })
    await db.loanApplication.update({ where: { id: "dec-shadow-digital" }, data: { status: "SUBMITTED", assignedToId: null } })
    await db.auditLog.create({ data: { tenantId: ids.tenant, action: "APPLICATION_SUBMITTED_BY_CLIENT", entity: "LoanApplication", entityId: "dec-shadow-digital", newValue: {} } })
    const checksBefore = await db.creditBureauCheck.count({ where: { tenantId: ids.tenant, applicationId: "dec-shadow-digital" } })
    bureauStub.run = async () => { throw new Error("a shadow rehearsal must never start a bureau review") }
    expect(await reviewDigitalSubmission({ tenantId: ids.tenant, applicationId: "dec-shadow-digital" })).toEqual({ status: "REHEARSED" })
    expect(await db.loanApplication.findUniqueOrThrow({ where: { id: "dec-shadow-digital" } })).toMatchObject({ status: "SUBMITTED", assignedToId: null, riskGrade: null })
    expect(await db.creditBureauCheck.count({ where: { tenantId: ids.tenant, applicationId: "dec-shadow-digital" } })).toBe(checksBefore)
    expect(await db.autoDecisionRun.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-shadow-digital" } })).toMatchObject({ mode: "SHADOW", trigger: "DIGITAL_SUBMISSION", execution: "NOT_ACTED", verdict: "APPROVE" })
    // No bureau data on file for another client: a no_bureau rehearsal, never a score.
    await underReview("dec-shadow-nobureau", { bureauScore: 640 })
    await db.creditBureauCheck.deleteMany({ where: { tenantId: ids.tenant, applicationId: "dec-shadow-nobureau" } })
    await db.loanApplication.update({ where: { id: "dec-shadow-nobureau" }, data: { status: "SUBMITTED" } })
    await reviewDigitalSubmission({ tenantId: ids.tenant, applicationId: "dec-shadow-nobureau" })
    expect(await db.autoDecisionRun.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-shadow-nobureau" } })).toMatchObject({ verdict: "REFER", reasonCodes: ["NO_BUREAU"], riskGrade: null })
  })

  it("a due row written before the task is scheduled lets the sweep run a review whose task was lost, once, and the daily limit stops spam", async () => {
    await approveChange(ENGINE_CONFIG_KIND, "Live, digital", engine({ mode: "LIVE", channels: ["PORTAL", "STAFF"], ...signOff }))
    bureauStub.run = async ({ applicationId, clientId, reviewGeneration }) => {
      const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
      await db.creditBureauCheck.create({ data: { tenantId: ids.tenant, clientId, applicationId, reviewGeneration, subjectFingerprint: bureauSubjectFingerprint(client), provider: "experian", score: 640, riskGrade: "LOW", adverseInfo: [], declineReasons: [], obligations: { totalMonthly: 0 }, ok: true } })
      return "completed"
    }
    await underReview("dec-swept", { bureauScore: 640, submittedAgoMs: 600_000 })
    await db.loanApplication.update({ where: { id: "dec-swept" }, data: { status: "SUBMITTED" } })
    expect(await markDigitalDecisionDue({ tenantId: ids.tenant, applicationId: "dec-swept", ip: "203.0.113.9" })).toBe(true)
    // The after-response task never ran. A fresh row is left alone; one past the grace period is swept.
    expect(await sweepDigitalDecisions()).toMatchObject({ swept: 0 })
    await db.$executeRawUnsafe(`UPDATE "AutoDecisionDue" SET "createdAt" = now() - interval '10 minutes' WHERE "tenantId" = '${ids.tenant}' AND "applicationId" = 'dec-swept'`)
    expect(await sweepDigitalDecisions()).toMatchObject({ swept: 1, failed: 0 })
    expect(await db.autoDecisionRun.count({ where: { tenantId: ids.tenant, applicationId: "dec-swept", trigger: "DIGITAL_SUBMISSION" } })).toBe(1)
    expect(await db.autoDecisionDue.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-swept" } })).toMatchObject({ outcome: "REVIEWED" })
    // Swept again: nothing to do.
    expect(await sweepDigitalDecisions()).toMatchObject({ swept: 0 })
    // The daily limit: three completed reviews for one client in a day, and the next is refused with no bureau pull.
    await underReview("dec-spam", { bureauScore: 640, clearFlags: false })
    await db.loanApplication.update({ where: { id: "dec-spam" }, data: { status: "SUBMITTED" } })
    for (let i = 0; i < 3; i++) {
      await db.autoDecisionDue.create({ data: { tenantId: ids.tenant, applicationId: `dec-earlier-${i}`, clientId: clientOf("dec-spam"), ip: "198.51.100.7", completedAt: new Date(), outcome: "REVIEWED" } })
    }
    const pulls = vi.fn(async () => "completed")
    bureauStub.run = pulls
    await db.autoDecisionDue.create({ data: { tenantId: ids.tenant, applicationId: "dec-spam", clientId: clientOf("dec-spam"), ip: "198.51.100.7", createdAt: new Date(Date.now() - 600_000) } })
    await runDigitalDue({ tenantId: ids.tenant, applicationId: "dec-spam" })
    expect(await db.autoDecisionDue.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-spam" } })).toMatchObject({ outcome: "RATE_LIMITED" })
    expect(pulls).not.toHaveBeenCalled()
    expect(await statusOf("dec-spam")).toBe("SUBMITTED")
    // ...and ten for one address, whoever the client is.
    for (let i = 0; i < 10; i++) {
      await db.autoDecisionDue.create({ data: { tenantId: ids.tenant, applicationId: `dec-ip-${i}`, clientId: `other-client-${i}`, ip: "198.51.100.99", completedAt: new Date(), outcome: "REVIEWED" } })
    }
    await underReview("dec-ip", { bureauScore: 640, clearFlags: false })
    await db.loanApplication.update({ where: { id: "dec-ip" }, data: { status: "SUBMITTED" } })
    await db.autoDecisionDue.create({ data: { tenantId: ids.tenant, applicationId: "dec-ip", clientId: clientOf("dec-ip"), ip: "198.51.100.99", createdAt: new Date(Date.now() - 600_000) } })
    await runDigitalDue({ tenantId: ids.tenant, applicationId: "dec-ip" })
    expect(await db.autoDecisionDue.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId: "dec-ip" } })).toMatchObject({ outcome: "RATE_LIMITED" })
    expect(pulls).not.toHaveBeenCalled()
  })

  it("decides well inside the 60 second target", () => {
    expect(latencies.length).toBeGreaterThanOrEqual(5)
    expect(Math.max(...latencies)).toBeLessThan(60_000)
  })
})
