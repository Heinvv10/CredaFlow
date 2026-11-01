/**
 * Real-Postgres proof that a KEY_FACTS application (a non-NCA instance: Lesotho) is approved through
 * the real decide route without the South African evidence, and that an NCA_PASQ application still
 * needs all of it. Every other approval gate runs for real, as in decision-log.integration.test.ts (the
 * submission snapshot, composite KYC, the affordability gate, screening, the credit-check recompute, the
 * locked re-verification and every LoanApplication trigger); nothing is installed with
 * session_replication_role.
 *
 * Each suite has its own throwaway database, because the instance's jurisdiction is a property of the
 * whole database. Mocked, as in decision-log.integration.test.ts: the RLS-bound client, the session
 * guard, the tenant frame, outbound notifications.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run 'app/api/applications/[id]/decide/decide-key-facts.integration.test.ts'
 */
import { randomBytes, randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null, tenantId: "", userId: "" }))

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
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({
    user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: "LOAN_ADMIN", tenantId: holder.tenantId, totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    withTenantContext: (_req: unknown, handler: (tenant: object) => Promise<unknown>) =>
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Decide key facts IT", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications")>()),
  triggerNotification: vi.fn(async () => undefined),
}))

import { createAppPrismaClient, prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createSubmissionAffordabilitySnapshot, readAffordabilitySnapshotStore, withAffordabilitySnapshot } from "@/lib/affordability/snapshot"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { ENGINE_CONFIG_KIND, RULE_SET_KIND } from "@/lib/decisioning/change-payloads"
import { runAutoDecision } from "@/lib/decisioning/auto-decision"
import { verifyLockedApprovalCandidate } from "@/lib/affordability/current-approval"
import { MATRIX_KIND } from "@/lib/approval/types"
import { POST } from "./route"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const ids = { tenant: `dkf-${t}`, officer: `dkf-officer-${t}`, product: `dkf-product-${t}`, maker: `dkf-maker-${t}`, checker: `dkf-checker-${t}` }
const maker = { id: ids.maker, email: `${ids.maker}@test.invalid`, role: "ADMIN", totpVerified: true }
const checker = { id: ids.checker, email: `${ids.checker}@test.invalid`, role: "SUPER_ADMIN", totpVerified: true }
const product = {
  productType: "MICRO" as const, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL" as const,
  initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900,
}
const terms = { appliedAmount: 500_000, appliedTermDays: 30 }
const expenses = { housing: 400_000, transport: 150_000, food: 150_000, insurance: 50_000, medical: 50_000 }
const longAgo = new Date(Date.now() - 2 * 365 * 86_400_000)

function decide(id: string, fields: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return POST(new NextRequest(`http://localhost/api/applications/${id}/decide`, { method: "POST", body: form }), { params: Promise.resolve({ id }) })
}

/** One suite on its own throwaway database whose instance is `jurisdiction`. */
function instanceSuite(label: string, jurisdiction: "LS" | "ZA") {
  const role = `cf_dkf_${jurisdiction.toLowerCase()}_${t}`
  let fresh: ThrowawayDb
  let app: ReturnType<typeof createAppPrismaClient> | undefined
  const db = () => fresh.db
  const tenant = `${ids.tenant}-${jurisdiction.toLowerCase()}`
  const clientOf = (id: string) => `${id}-client`

  /**
   * An UNDER_REVIEW application with intact submission evidence and four verified KYC documents, and
   * (when `nca`) the South African evidence: credit-life no-offer disclosure, affordability declaration,
   * reckless-lending assessment and a current bureau check. A KEY_FACTS application has none of it.
   */
  async function underReview(id: string, opts: { nca: boolean; documents?: boolean; income?: number; generation?: boolean }) {
    const clientId = clientOf(id)
    const ls = jurisdiction === "LS"
    await db().client.create({
      data: {
        id: clientId, tenantId: tenant, reference: `CLI-${id}`, idNumber: ls ? `99${randomBytes(4).toString("hex").replace(/[a-f]/g, "1").slice(0, 7)}` : syntheticSaIdNumber(), firstName: "Synthetic", lastName: "Borrower",
        email: `${id}@test.invalid`, phone: ls ? "+26658000011" : "+27820000000", grossMonthlyIncome: 2_200_000, monthlyIncome: opts.income ?? 2_000_000, monthlyExpenses: 800_000,
        expenseBreakdown: { create: expenses },
      },
    })
    if (opts.documents !== false) {
      for (const docType of ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const) {
        await db().clientDocument.create({
          data: {
            tenantId: tenant, clientId, docType, fileUrl: `/synthetic/${docType}`, fileName: `${docType}.pdf`, fileSize: 1024, mimeType: "application/pdf",
            contentSha256: randomBytes(32).toString("hex"), extractionStatus: "skipped", verified: true, verifiedAt: longAgo, verifiedById: ids.officer, createdAt: longAgo, uploadedByType: "staff",
          },
        })
      }
    }
    const client = await db().client.findUniqueOrThrow({ where: { id: clientId }, include: { expenseBreakdown: true } })
    const submittedAt = new Date(Date.now() - 60 * 60_000)
    const submission = createSubmissionAffordabilitySnapshot({
      capturedAt: submittedAt, capturedById: ids.officer, client, applicationDebts: [], clientDebts: [],
      application: { ...terms, productId: ids.product, initiationFeePayment: "DEFERRED" }, product,
    })
    const noOffer = { version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION, election: "DECLINED" as const, principalCents: terms.appliedAmount, termDays: terms.appliedTermDays }
    await db().loanApplication.create({
      data: {
        id, tenantId: tenant, reference: `APP-${id}`, clientId, productId: ids.product, ...terms, initiationFeePayment: "DEFERRED", status: "UNDER_REVIEW", submittedAt,
        assignedToId: ids.officer, bureauReviewGeneration: opts.nca || opts.generation ? randomUUID() : null, existingDebtObligations: [],
        affordabilityResult: withAffordabilitySnapshot(null, submission) as object,
        ...(opts.nca ? {
          clientAffordabilityDeclaredAt: submittedAt, recklessLendingAssessed: true, recklessLendingAssessedAt: submittedAt, recklessLendingAssessedById: ids.officer,
          creditLifeElection: "DECLINED" as const, creditLifeMonthlyPremiumCents: 0, creditLifeDisclosureVersion: noOffer.version,
          creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256(noOffer), creditLifeDisclosureAcknowledgedAt: submittedAt, creditLifeDisclosureAcknowledgedBy: clientId,
        } : {}),
      },
    })
    return db().loanApplication.findUniqueOrThrow({ where: { id } })
  }

  async function clearFlags(id: string) {
    await runWithTenant(tenant, () => recomputeApplicationFlags(tenant, id, { userId: ids.officer }))
    await db().applicationCheckFlag.updateMany({
      where: { tenantId: tenant, applicationId: id, status: "OPEN" },
      data: { status: "CLEARED", clearedById: ids.officer, clearedAt: new Date(), clearReason: "Synthetic: income verified by other means." },
    })
  }

  async function setup() {
    fresh = await createThrowawayDb({ instance: { jurisdiction, currency: jurisdiction === "LS" ? "LSL" : "ZAR" } })
    holder.tenantId = tenant
    holder.userId = ids.officer
    await db().tenant.create({ data: { id: tenant, slug: tenant, name: "Decide key facts IT" } })
    // Screening is the identity-risk check a key-facts loan relies on (it has no bureau), so the Lesotho tenant has a provider: the simulated one, which a demo stack may use.
    await db().tenantConfig.create({ data: { tenantId: tenant, bureauMinScore: 580, ...(jurisdiction === "LS" ? { screeningProvider: "simulated" } : {}) } })
    for (const [id, userRole] of [[ids.officer, "LOAN_ADMIN"], [ids.maker, "ADMIN"], [ids.checker, "ADMIN"]] as const) {
      await db().user.create({ data: { id, tenantId: tenant, email: `${id}@test.invalid`, password: "not-a-real-login", name: id, role: userRole, createdAt: new Date(Date.now() - 90 * 86_400_000) } })
    }
    await db().loanProduct.create({ data: { id: ids.product, tenantId: tenant, code: `DKF-${t}`, name: "Decide key facts micro", minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, ...product } })
    const password = randomBytes(12).toString("hex")
    await db().$executeRawUnsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
    await db().$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
    await db().$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
    await db().$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
    const url = new URL(fresh.url)
    url.username = role
    url.password = password
    url.searchParams.set("connection_limit", "1")
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(url.toString())
    holder.app = app
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
  }

  async function teardown() {
    vi.unstubAllEnvs()
    holder.app = null
    await app?.$disconnect()
    await fresh?.db.$executeRawUnsafe(`DROP OWNED BY ${role}`).catch(() => undefined)
    await fresh?.drop()
    const admin = new PrismaClient()
    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined)
    await admin.$disconnect()
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
  }

  /** A maker-checker change of the lender's decision-engine configuration, approved by a second person. */
  async function change(kind: string, title: string, payload: object) {
    const draft = await createDraft({ tenantId: tenant, actor: maker, kind, title, payload })
    await submit({ tenantId: tenant, actor: maker, id: draft.id })
    await approve({ tenantId: tenant, actor: checker, id: draft.id })
  }

  /** The locked re-verification decide runs inside its transaction, reached directly: a pre-check cannot answer for it. */
  const locked = (id: string, updatedAt: Date) => runWithTenant(tenant, () => prisma.$transaction((tx) => verifyLockedApprovalCandidate(tx as never, {
    tenantId: tenant, applicationId: id, expectedApplicationUpdatedAt: updatedAt, expectedApproval: {} as never, capturedAt: new Date(), calculationStartDate: new Date(), capturedById: ids.officer, bureauOverrideReason: null, expectedPasqDocumentSha256: null,
  })))

  return { label, db, tenant, underReview, clearFlags, change, locked, setup, teardown }
}

const bureauRules = [
  { id: "dead", name: "Deceased", outcome: "KNOCK_OUT", reasonCode: "BUREAU_DECEASED", declineCategory: "POLICY", when: { field: "bureauDeceased", op: "eq", value: true } },
  { id: "low", name: "Score below 560", outcome: "KNOCK_OUT", reasonCode: "BUREAU_SCORE_LOW", declineCategory: "BUREAU_SCORE", when: { field: "bureauScore", op: "lt", value: 560 } },
]
const liveEngine = () => ({ mode: "LIVE", channels: ["STAFF"], productIds: [ids.product], repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0, s71SignOff: false, automatedDeclineNotice: null })
// A missing bureau score scores 700, grade A: the shape of a lender's South African scorecard run on nobody's bureau report.
const scoredRules = {
  productId: null, name: "Scored", effectiveFrom: "2026-01-01", challengerOnly: false, rules: bureauRules,
  scorecard: { baseScore: 600, characteristics: [{ field: "bureauScore", bins: [{ min: 0, max: 1000, points: 0 }], missingPoints: 100 }], bands: [{ minScore: 650, grade: "A", action: "ALLOW" }, { minScore: 0, grade: "C", action: "ALLOW" }] },
}
// The go-live condition of docs/non-nca-go-live.md: an ungraded key-facts application takes both levels.
const ungradedTwoLevels = {
  name: "Ungraded two", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 1,
  rules: [{ id: "ungraded", name: "Ungraded", when: { ungraded: true }, requiredLevels: 2 }],
  levels: [{ level: 1, name: "One", role: "LOAN_ADMIN", slaHours: 24, committee: false }, { level: 2, name: "Two", role: "ADMIN", slaHours: 24, committee: false }],
}

const ls = instanceSuite("Lesotho", "LS")
suite("decide, a Lesotho (KEY_FACTS) instance: the South African evidence is not asked for (real Postgres, real route)", () => {
  beforeAll(() => ls.setup(), 240_000)
  afterAll(() => ls.teardown(), 60_000)

  it("approves an application with no credit-life election, no affordability declaration, no reckless-lending assessment and no bureau check", async () => {
    const id = `ok-${t}`
    const application = await ls.underReview(id, { nca: false })
    expect(application.disclosureRegime).toBe("KEY_FACTS")
    expect(application.creditLifeElection).toBeNull()
    expect(application.clientAffordabilityDeclaredAt).toBeNull()
    expect(application.recklessLendingAssessed).toBe(false)
    await ls.clearFlags(id)

    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)

    const approved = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect(approved).toMatchObject({ status: "APPROVED", disclosureRegime: "KEY_FACTS", approvedById: ids.officer, repaymentMethod: "EFT", pasqVersion: null, pasqDocumentId: null })
    expect(await ls.db().auditLog.count({ where: { tenantId: ls.tenant, entityId: id, action: "LOAN_APPROVED" } })).toBe(1)
    const approval = readAffordabilitySnapshotStore(approved.affordabilityResult).approval
    // The bureau slot records that no check applied, not that one was waived; credit life is priced as no offer.
    expect(approval?.bureauEvidence).toMatchObject({ mode: "CHECK", check: null, override: null })
    expect(approval?.inputs).toMatchObject({ creditLifePremiumCents: 0 })
    expect(await ls.db().creditDecisionRecord.count({ where: { tenantId: ls.tenant, applicationId: id } })).toBe(2)
  })

  it("still holds approval for what applies in every jurisdiction: KYC, the credit checks, and an unaffordable loan", async () => {
    const noDocs = `nodocs-${t}`
    await ls.underReview(noDocs, { nca: false, documents: false })
    const kyc = await decide(noDocs, { action: "approve", repaymentMethod: "EFT" })
    expect(kyc.status).toBe(422)
    expect(await kyc.json()).toMatchObject({ error: "KYC not complete." })

    const open = `open-${t}`
    await ls.underReview(open, { nca: false })
    const checks = await decide(open, { action: "approve", repaymentMethod: "EFT" })
    expect(checks.status, "the credit-check recompute raises its findings and they block until cleared").toBe(409)
    expect(await checks.json()).toMatchObject({ openChecks: expect.any(Array) })

    const poor = `poor-${t}`
    await ls.underReview(poor, { nca: false, income: 900_000 })
    await ls.clearFlags(poor)
    const afford = await decide(poor, { action: "approve", repaymentMethod: "EFT" })
    expect(afford.status).toBe(422)
    expect(String((await afford.json()).error)).toMatch(/^Affordability gate/)
    for (const id of [noDocs, open, poor]) expect((await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })).status).toBe("UNDER_REVIEW")
  })

  it("refuses a client the lender recorded as deceased, with no override (the bureau was the only deceased gate)", async () => {
    const id = `dead-${t}`
    await ls.underReview(id, { nca: false })
    await ls.db().client.update({ where: { id: `${id}-client` }, data: { deceasedAt: new Date(), deceasedReason: "Synthetic" } })
    await ls.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT", bureauOverrideReason: "Synthetic override reason, long enough for the minimum length." })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ deceasedBlock: true, requiresOverride: false })
    expect((await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })).status).toBe("UNDER_REVIEW")
  })

  it("refuses approval while no screening provider is configured: a key-facts loan has no bureau, so screening is its only identity-risk check", async () => {
    const id = `noscreen-${t}`
    await ls.underReview(id, { nca: false })
    await ls.clearFlags(id)
    await ls.db().tenantConfig.update({ where: { tenantId: ls.tenant }, data: { screeningProvider: null } })
    try {
      const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ screening: { state: "NOT_CONFIGURED" }, screeningProviderRequired: true, requiresOverride: false })
      expect((await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })).status).toBe("UNDER_REVIEW")
    } finally {
      await ls.db().tenantConfig.update({ where: { tenantId: ls.tenant }, data: { screeningProvider: "simulated" } })
    }
  })

  it("refuses a bureau override reason with no bureau check to override: nothing is approved on it and no s81 assessment is stamped", async () => {
    const id = `override-${t}`
    await ls.underReview(id, { nca: false })
    await ls.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT", bureauOverrideReason: "Synthetic override reason, long enough for the minimum length." })
    expect(res.status).toBe(422)
    const row = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: "UNDER_REVIEW", bureauOverrideReason: null, recklessLendingAssessed: false, recklessLendingAssessedAt: null, recklessLendingAssessedById: null })
  })

  it("the real locked verifier refuses a client the lender recorded as deceased", async () => {
    const id = `lockdead-${t}`
    await ls.underReview(id, { nca: false })
    await ls.db().client.update({ where: { id: `${id}-client` }, data: { deceasedAt: new Date(), deceasedReason: "Synthetic" } })
    const row = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect(await ls.locked(id, row.updatedAt)).toMatchObject({ ok: false, reason: "compliance_changed" })
  })

  it("refuses an ACCEPTED credit-life election through the route (credit life is off outside the NCA's jurisdiction)", async () => {
    const id = `cover-${t}`
    await ls.underReview(id, { nca: false })
    const insurer = await ls.db().insurer.create({ data: { id: `ins-${id}`, tenantId: ls.tenant, name: "Synthetic Insurer" } as never })
    const cover = await ls.db().insuranceProduct.create({ data: { id: `cov-${id}`, tenantId: ls.tenant, insurerId: insurer.id, name: "Synthetic Cover", code: `COV-${id}`, type: "CREDIT_LIFE", premiumAmount: 250, sumAssured: 5000 } as never })
    await ls.db().loanApplication.update({
      where: { id },
      data: {
        creditLifeElection: "ACCEPTED", creditLifeProductId: cover.id, creditLifeProductName: "Synthetic Cover", creditLifeInsurerId: insurer.id, creditLifeInsurerName: "Synthetic Insurer",
        creditLifeMonthlyPremiumCents: 25_000, creditLifeDisclosureVersion: "credit-life-election-v1", creditLifeDisclosureSha256: "a".repeat(64),
        creditLifeDisclosureAcknowledgedAt: new Date(), creditLifeDisclosureAcknowledgedBy: `${id}-client`,
      },
    })
    await ls.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ creditLifeEvidence: "not_offered" })
    // And the database refuses the same approval written directly (with no provider configured the screening trigger is silent, so this is the CHECK speaking).
    await ls.db().tenantConfig.update({ where: { tenantId: ls.tenant }, data: { screeningProvider: null } })
    await expect(ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = '${ids.officer}', "approvedAmount" = 500000, "approvedTermDays" = 30, "approvedRate" = 0.05, "repaymentMethod" = 'EFT' WHERE id = '${id}'`)).rejects.toThrow(/LoanApplication_key_facts_no_credit_life/)
    await ls.db().tenantConfig.update({ where: { tenantId: ls.tenant }, data: { screeningProvider: "simulated" } })
  })

  it("a LIVE engine refers a key-facts application to staff instead of approving it on rules that never fired for want of a bureau check", async () => {
    await ls.change(RULE_SET_KIND, "rules", { productId: null, name: "SA-style rules", effectiveFrom: "2026-01-01", challengerOnly: false, rules: bureauRules, scorecard: null })
    await ls.change(ENGINE_CONFIG_KIND, "live", liveEngine())
    const id = `engine-${t}`
    await ls.underReview(id, { nca: false, generation: true })
    await ls.clearFlags(id)
    const outcome = await runAutoDecision({ tenantId: ls.tenant, applicationId: id, trigger: "MANUAL" })
    expect(outcome).toMatchObject({ status: "RAN", execution: "REFERRED", verdict: { decision: "REFER", reasonCodes: ["NO_BUREAU"] } })
    expect((await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })).status).toBe("UNDER_REVIEW")
  })

  it("a referred application nobody bureau-checked carries no grade, on a LIVE engine with a scorecard", async () => {
    await ls.change(RULE_SET_KIND, "scored", scoredRules)
    await ls.change(ENGINE_CONFIG_KIND, "live", liveEngine())
    const id = `graded-${t}`
    await ls.underReview(id, { nca: false, generation: true })
    await ls.clearFlags(id)
    expect(await runAutoDecision({ tenantId: ls.tenant, applicationId: id, trigger: "MANUAL" })).toMatchObject({ execution: "REFERRED", verdict: { riskGrade: null, gradeRank: null, score: null, pricingTier: null } })
    expect(await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ riskGrade: null, riskGradeRank: null, riskScore: null, riskPricingTier: null })
  })

  it("the referral does not take the application out of the matrix's ungraded rule: it still needs its second approver", async () => {
    await ls.change(MATRIX_KIND, "matrix", ungradedTwoLevels)
    await ls.change(ENGINE_CONFIG_KIND, "off", { ...liveEngine(), mode: "OFF" })
    const control = `ungraded-c-${t}`
    await ls.underReview(control, { nca: false, generation: true })
    await ls.clearFlags(control)
    await decide(control, { action: "approve", repaymentMethod: "EFT" })
    expect((await ls.db().loanApplication.findUniqueOrThrow({ where: { id: control } })).status).toBe("UNDER_REVIEW")

    await ls.change(ENGINE_CONFIG_KIND, "live", liveEngine())
    const id = `ungraded-${t}`
    await ls.underReview(id, { nca: false, generation: true })
    await ls.clearFlags(id)
    await runAutoDecision({ tenantId: ls.tenant, applicationId: id, trigger: "MANUAL" })
    await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "UNDER_REVIEW", riskGrade: null })
  })
})

const za = instanceSuite("South Africa", "ZA")
suite("decide, a South African (NCA_PASQ) instance: the same application still needs every item (real Postgres, real route)", () => {
  beforeAll(() => za.setup(), 240_000)
  afterAll(() => za.teardown(), 60_000)

  it("refuses an application with none of the NCA evidence, and names the first it is missing: the credit-life election (the next two tests reach the others)", async () => {
    const id = `za-${t}`
    const application = await za.underReview(id, { nca: false })
    expect(application.disclosureRegime).toBe("NCA_PASQ")
    // No credit-life election either: the credit-life gate speaks first.
    const first = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(first.status).toBe(422)
    expect(await first.json()).toMatchObject({ missingComplianceEvidence: ["credit-life election"] })
  })

  it("an NCA application with a credit-life disclosure but no declaration or assessment is refused for exactly those", async () => {
    const id = `za2-${t}`
    await za.underReview(id, { nca: true })
    await za.db().loanApplication.update({ where: { id }, data: { clientAffordabilityDeclaredAt: null, recklessLendingAssessed: false, recklessLendingAssessedAt: null, recklessLendingAssessedById: null } })
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ missingComplianceEvidence: ["client affordability declaration", "reckless-lending assessment"] })
  })

  it("an NCA application with everything but a bureau check is refused for the bureau", async () => {
    const id = `za3-${t}`
    await za.underReview(id, { nca: true })
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ bureauMissing: true, requiresOverride: true })
  })

  it("the real locked verifier refuses a row with no NCA evidence, one with everything but the bureau, and a deceased client", async () => {
    const bare = `lock1-${t}`
    await za.underReview(bare, { nca: false, generation: true })
    const bareRow = await za.db().loanApplication.findUniqueOrThrow({ where: { id: bare } })
    expect(await za.locked(bare, bareRow.updatedAt)).toMatchObject({ ok: false, reason: "compliance_changed" })

    const noBureau = `lock2-${t}`
    await za.underReview(noBureau, { nca: true })
    const noBureauRow = await za.db().loanApplication.findUniqueOrThrow({ where: { id: noBureau } })
    expect(await za.locked(noBureau, noBureauRow.updatedAt)).toMatchObject({ ok: false, reason: "bureau_missing" })

    const dead = `lock3-${t}`
    await za.underReview(dead, { nca: true })
    await za.db().client.update({ where: { id: `${dead}-client` }, data: { deceasedAt: new Date(), deceasedReason: "Synthetic" } })
    const deadRow = await za.db().loanApplication.findUniqueOrThrow({ where: { id: dead } })
    expect(await za.locked(dead, deadRow.updatedAt)).toMatchObject({ ok: false, reason: "compliance_changed" })
  })

  it("refuses a client the lender recorded as deceased whatever the regime, with no override", async () => {
    const id = `zadead-${t}`
    await za.underReview(id, { nca: true })
    await za.db().client.update({ where: { id: `${id}-client` }, data: { deceasedAt: new Date(), deceasedReason: "Synthetic" } })
    await za.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT", bureauOverrideReason: "Synthetic override reason, long enough for the minimum length." })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ deceasedBlock: true, requiresOverride: false })
  })

  it("still approves with no screening provider configured (only a key-facts loan requires one) and a bureau override stamps the assessment, as before", async () => {
    const id = `zaok-${t}`
    await za.underReview(id, { nca: true })
    await za.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT", bureauOverrideReason: "Synthetic override reason, long enough for the minimum length." })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    const approved = await za.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect(approved).toMatchObject({ status: "APPROVED", recklessLendingAssessed: true, recklessLendingAssessedById: ids.officer })
  })
})
