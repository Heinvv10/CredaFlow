/**
 * PR #277 breaker round 3, on a5289f8d. Each test asserts the SAFE behaviour: RED = broken, GREEN = holds.
 * Run from a clone at a5289f8d, copied to app/api/applications/[id]/decide/:
 *   RUN_DB_IT=1 DATABASE_URL=... npx vitest run --testTimeout=60000 --hookTimeout=240000 'app/api/applications/[id]/decide/brk277-round3.integration.test.ts'
 */
import { appendFileSync } from "node:fs"
import { randomBytes, randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN" }))

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, {
    get(_target, key) {
      if (!holder.app) throw new Error("no app client")
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
    user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: holder.role, tenantId: holder.tenantId, totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    withTenantContext: (_req: unknown, handler: (tenant: object) => Promise<unknown>) =>
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "brk", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications")>()),
  triggerNotification: vi.fn(async () => undefined),
}))

import { createAppPrismaClient, prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createSubmissionAffordabilitySnapshot, withAffordabilitySnapshot } from "@/lib/affordability/snapshot"
import { verifyLockedCurrentAffordabilityApproval } from "@/lib/affordability/current-approval"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { runBureauReviewCheck } from "@/lib/compliance/bureau-review"
import { CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { ENGINE_CONFIG_KIND, RULE_SET_KIND } from "@/lib/decisioning/change-payloads"
import { runAutoDecision } from "@/lib/decisioning/auto-decision"
import { requireLivingBorrower } from "@/lib/non-nca-documents/borrower-gate"
import { loadCreditLifeOffer } from "@/lib/insurance/credit-life-offer"
import { verifyLockedApprovalCandidate as lockedCandidate } from "@/lib/affordability/current-approval"
import { MATRIX_KIND } from "@/lib/approval/types"
import { POST } from "./route"

const dbMsg = (label: string, m: string) => appendFileSync(process.env.BRK_MSGS ?? "/dev/null", `${label}: ${m.slice(-260).replace(/\n/g, " ")}\n`)
const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const ids = { tenant: `brk-${t}`, officer: `brk-officer-${t}`, product: `brk-product-${t}`, maker: `brk-maker-${t}`, checker: `brk-checker-${t}` }
const product = { productType: "MICRO" as const, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900 }
const terms = { appliedAmount: 500_000, appliedTermDays: 30 }
const fair = { housing: 400_000, transport: 150_000, food: 150_000, insurance: 50_000, medical: 50_000 }
const longAgo = new Date(Date.now() - 2 * 365 * 86_400_000)
const maker = { id: ids.maker, email: `${ids.maker}@test.invalid`, role: "ADMIN", totpVerified: true }
const checker = { id: ids.checker, email: `${ids.checker}@test.invalid`, role: "SUPER_ADMIN", totpVerified: true }

function decide(id: string, fields: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return POST(new NextRequest(`http://localhost/api/applications/${id}/decide`, { method: "POST", body: form }), { params: Promise.resolve({ id }) })
}

function instanceSuite(jurisdiction: "LS" | "ZA") {
  const role = `cf_brk_${jurisdiction.toLowerCase()}_${t}`
  let fresh: ThrowawayDb
  let app: ReturnType<typeof createAppPrismaClient> | undefined
  const db = () => fresh.db
  const tenant = `${ids.tenant}-${jurisdiction.toLowerCase()}`

  type Opts = { nca?: boolean; noOffer?: boolean; expenses?: typeof fair; generation?: boolean }
  async function underReview(id: string, opts: Opts = {}) {
    const clientId = `${id}-client`
    const ls = jurisdiction === "LS"
    const expenses = opts.expenses ?? fair
    const total = Object.values(expenses).reduce((a, b) => a + b, 0)
    await db().client.create({
      data: {
        id: clientId, tenantId: tenant, reference: `CLI-${id}`, idNumber: ls ? `99${randomBytes(4).toString("hex").replace(/[a-f]/g, "1").slice(0, 7)}` : syntheticSaIdNumber(), firstName: "Synthetic", lastName: "Borrower",
        email: `${id}@test.invalid`, phone: ls ? "+26658000011" : "+27820000000", grossMonthlyIncome: 2_200_000, monthlyIncome: 2_000_000, monthlyExpenses: total,
        dateOfBirth: new Date("1988-03-02T00:00:00Z"), employmentStatus: "EMPLOYED", expenseBreakdown: { create: expenses },
      },
    })
    for (const docType of ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const) {
      await db().clientDocument.create({ data: { tenantId: tenant, clientId, docType, fileUrl: `/synthetic/${docType}`, fileName: `${docType}.pdf`, fileSize: 1024, mimeType: "application/pdf", contentSha256: randomBytes(32).toString("hex"), extractionStatus: "skipped", verified: true, verifiedAt: longAgo, verifiedById: ids.officer, createdAt: longAgo, uploadedByType: "staff" } })
    }
    const client = await db().client.findUniqueOrThrow({ where: { id: clientId }, include: { expenseBreakdown: true } })
    const submittedAt = new Date(Date.now() - 60 * 60_000)
    const submission = createSubmissionAffordabilitySnapshot({ capturedAt: submittedAt, capturedById: ids.officer, client, applicationDebts: [], clientDebts: [], application: { ...terms, productId: ids.product, initiationFeePayment: "DEFERRED" }, product })
    const noOffer = { version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION, election: "DECLINED" as const, principalCents: terms.appliedAmount, termDays: terms.appliedTermDays }
    const credit = opts.nca || opts.noOffer ? {
      creditLifeElection: "DECLINED" as const, creditLifeMonthlyPremiumCents: 0, creditLifeDisclosureVersion: noOffer.version,
      creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256(noOffer), creditLifeDisclosureAcknowledgedAt: submittedAt, creditLifeDisclosureAcknowledgedBy: clientId,
    } : {}
    await db().loanApplication.create({
      data: {
        id, tenantId: tenant, reference: `APP-${id}`, clientId, productId: ids.product, ...terms, initiationFeePayment: "DEFERRED", status: "UNDER_REVIEW", submittedAt,
        assignedToId: ids.officer, bureauReviewGeneration: opts.nca || opts.generation ? randomUUID() : null, existingDebtObligations: [],
        affordabilityResult: withAffordabilitySnapshot(null, submission) as object, ...credit,
        ...(opts.nca ? { clientAffordabilityDeclaredAt: submittedAt, recklessLendingAssessed: true, recklessLendingAssessedAt: submittedAt, recklessLendingAssessedById: ids.officer } : {}),
      },
    })
    return db().loanApplication.findUniqueOrThrow({ where: { id } })
  }

  async function clearFlags(id: string) {
    await runWithTenant(tenant, () => recomputeApplicationFlags(tenant, id, { userId: ids.officer }))
    await db().applicationCheckFlag.updateMany({ where: { tenantId: tenant, applicationId: id, status: "OPEN" }, data: { status: "CLEARED", clearedById: ids.officer, clearedAt: new Date(), clearReason: "Synthetic: income verified by other means." } })
  }

  async function change(kind: string, title: string, payload: object) {
    const draft = await createDraft({ tenantId: tenant, actor: maker, kind, title, payload })
    await submit({ tenantId: tenant, actor: maker, id: draft.id })
    await approve({ tenantId: tenant, actor: checker, id: draft.id })
  }

  async function setup() {
    fresh = await createThrowawayDb({ instance: { jurisdiction, currency: jurisdiction === "LS" ? "LSL" : "ZAR" } })
    holder.tenantId = tenant
    holder.userId = ids.officer
    await db().tenant.create({ data: { id: tenant, slug: tenant, name: "brk" } })
    await db().tenantConfig.create({ data: { tenantId: tenant, bureauMinScore: 580, ...(jurisdiction === "LS" ? { screeningProvider: "simulated" } : {}) } })
    for (const [id, r] of [[ids.officer, "LOAN_ADMIN"], [ids.maker, "ADMIN"], [ids.checker, "ADMIN"]] as const) {
      await db().user.create({ data: { id, tenantId: tenant, email: `${id}@test.invalid`, password: "not-a-real-login", name: id, role: r, createdAt: new Date(Date.now() - 90 * 86_400_000) } })
    }
    await db().loanProduct.create({ data: { id: ids.product, tenantId: tenant, code: `BRK-${t}`, name: "brk micro", minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, ...product } })
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
  return { db, tenant, underReview, clearFlags, change, setup, teardown }
}

const RULES = [
  { id: "dead", name: "Deceased", outcome: "KNOCK_OUT", reasonCode: "BUREAU_DECEASED", declineCategory: "POLICY", when: { field: "bureauDeceased", op: "eq", value: true } },
  { id: "low", name: "Score below 560", outcome: "KNOCK_OUT", reasonCode: "BUREAU_SCORE_LOW", declineCategory: "BUREAU_SCORE", when: { field: "bureauScore", op: "lt", value: 560 } },
  { id: "review", name: "Under debt review", outcome: "REFER", reasonCode: "DEBT_REVIEW", when: { field: "bureauUnderDebtReview", op: "eq", value: true } },
]
const engine = () => ({ mode: "LIVE", channels: ["STAFF"], productIds: [ids.product], repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0, s71SignOff: false, automatedDeclineNotice: null })
const ruleSet = { productId: null, name: "SA-style rules", effectiveFrom: "2026-01-01", challengerOnly: false, rules: RULES, scorecard: null }
const matrix = { name: "Two levels", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 2, rules: [], levels: [
  { level: 1, name: "One", role: "LOAN_ADMIN", slaHours: 24, committee: false }, { level: 2, name: "Two", role: "ADMIN", slaHours: 24, committee: false },
] }

async function cover(db: PrismaClient, tenantId: string, n: string) {
  const insurer = await db.insurer.create({ data: { id: `ins-${n}`, tenantId, name: `Insurer ${n}` } as never })
  const productRow = await db.insuranceProduct.create({ data: { id: `cov-${n}`, tenantId, insurerId: insurer.id, name: "Synthetic Cover", code: `COV-${n}`, type: "CREDIT_LIFE", premiumAmount: 250, sumAssured: 5000 } as never })
  return { insurerId: insurer.id, productId: productRow.id, insurerName: `Insurer ${n}` }
}
const ls = instanceSuite("LS")
const scorecard = { baseScore: 600, characteristics: [{ field: "bureauScore", bins: [{ min: 0, max: 1000, points: 0 }], missingPoints: 100 }], bands: [{ minScore: 650, grade: "A", action: "ALLOW" }, { minScore: 0, grade: "C", action: "ALLOW" }] }
const scored = { productId: null, name: "scored", effectiveFrom: "2026-01-01", challengerOnly: false, rules: RULES, scorecard }
// The go-live condition of lib/non-nca-documents/.claude.md: an ungraded key-facts application takes both levels.
const ungradedTwoLevels = { name: "Ungraded two", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 1, rules: [{ id: "ungraded", name: "Ungraded", when: { ungraded: true }, requiredLevels: 2 }], levels: matrix.levels }
const locked = (tenant: string, id: string, updatedAt: Date) => runWithTenant(tenant, () => prisma.$transaction((tx) => lockedCandidate(tx as never, {
  tenantId: tenant, applicationId: id, expectedApplicationUpdatedAt: updatedAt, expectedApproval: {} as never, capturedAt: new Date(), calculationStartDate: new Date(), capturedById: ids.officer, bureauOverrideReason: null, expectedPasqDocumentSha256: null,
})))

const reviewReason = "Synthetic reason long enough to return this."
const declining = { ...scored, name: "declining", scorecard: { baseScore: 100, characteristics: scorecard.characteristics.map((c) => ({ ...c, missingPoints: 0 })), bands: [{ minScore: 650, grade: "A", action: "ALLOW" }, { minScore: 0, grade: "E", action: "DECLINE", declineCategory: "BUREAU_SCORE" }] } }
const signedEngine = () => ({ ...engine(), s71SignOff: true, automatedDeclineNotice: "Synthetic automated decision notice approved for this test." })

suite("round 3, Lesotho", () => {
  beforeAll(async () => {
    await ls.setup()
    await ls.db().tenantConfig.update({ where: { tenantId: ls.tenant }, data: { screeningProvider: "simulated" } })
  }, 240_000)
  afterAll(() => ls.teardown(), 60_000)

  it("G1 L3 retest: no grade on a referral", async () => {
    await ls.change(RULE_SET_KIND, "scored", scored)
    await ls.change(ENGINE_CONFIG_KIND, "live", engine())
    const id = `g1-${t}`
    await ls.underReview(id, { generation: true })
    await ls.clearFlags(id)
    const outcome = await runAutoDecision({ tenantId: ls.tenant, applicationId: id, trigger: "MANUAL" })
    const row = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect(outcome.status === "RAN" ? outcome.execution : outcome.reason).toBe("REFERRED")
    expect({ g: row.riskGrade, r: row.riskGradeRank, s: row.riskScore, p: row.riskPricingTier }).toEqual({ g: null, r: null, s: null, p: null })
  })

  it("G2 L4 retest: a referral keeps the ungraded matrix rule, one approver is not enough", async () => {
    await ls.change(MATRIX_KIND, "matrix", ungradedTwoLevels)
    const id = `g2-${t}`
    await ls.underReview(id, { generation: true })
    await ls.clearFlags(id)
    await runAutoDecision({ tenantId: ls.tenant, applicationId: id, trigger: "MANUAL" })
    await decide(id, { action: "approve", repaymentMethod: "EFT" })
    const row = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect({ status: row.status, grade: row.riskGrade }).toEqual({ status: "UNDER_REVIEW", grade: null })
    await ls.change(MATRIX_KIND, "matrix off", { ...ungradedTwoLevels, enabled: false })
  })

  it("G3 a scorecard built on bureau facts must not auto-decline a KEY_FACTS applicant nobody bureau-checked", async () => {
    await ls.change(RULE_SET_KIND, "declining", { ...declining, effectiveFrom: "2026-01-02" })
    await ls.change(ENGINE_CONFIG_KIND, "signed", signedEngine())
    const id = `g3-${t}`
    await ls.underReview(id, { generation: true })
    await ls.clearFlags(id)
    const outcome = await runAutoDecision({ tenantId: ls.tenant, applicationId: id, trigger: "MANUAL" })
    const row = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    appendFileSync(process.env.BRK_MSGS ?? "/dev/null", `G3: ${JSON.stringify({ o: outcome.status === "RAN" ? [outcome.execution, outcome.verdict.reasonCodes, outcome.note] : outcome.reason, status: row.status, cat: row.declineCategory })}\n`)
    expect(row.status).toBe("UNDER_REVIEW")
    await ls.change(ENGINE_CONFIG_KIND, "off", { ...engine(), mode: "OFF" })
  })

  it("B1 the gate under the real RLS role: a living borrower passes, a deceased or other-tenant one is refused", async () => {
    const id = `b1-${t}`
    await ls.underReview(id)
    const gate = (clientId: string, tenantId = ls.tenant) => runWithTenant(ls.tenant, () => prisma.$transaction((tx) => requireLivingBorrower(tx as never, { tenantId, applicationId: id, clientId, refusal: "no" })))
    await expect(gate(`${id}-client`)).resolves.toBeUndefined()
    await expect(gate(`${id}-client`, "another-tenant")).rejects.toThrow("no")
    await ls.db().client.update({ where: { id: `${id}-client` }, data: { deceasedAt: new Date(), deceasedReason: "Synthetic" } })
    await expect(gate(`${id}-client`)).rejects.toThrow("no")
  })

  it("O1 the loader: a product row on LS offers nothing to a new or KEY_FACTS application and stays for an NCA_PASQ one", async () => {
    const c = await cover(ls.db(), ls.tenant, `o1-${t}`)
    const offer = await ls.db().insuranceProduct.findFirst({ where: { id: c.productId } })
    expect(offer).not.toBeNull()
    await runWithTenant(ls.tenant, async () => {
      expect(await loadCreditLifeOffer(prisma as never, ls.tenant)).toBeNull()
      expect(await loadCreditLifeOffer(prisma as never, ls.tenant, "KEY_FACTS")).toBeNull()
    })
  })

  it("O2 with a product row on LS, a KEY_FACTS approval and return to review neither blocks nor invents an offer", async () => {
    const id = `o2-${t}`
    await ls.underReview(id)
    await ls.clearFlags(id)
    expect((await decide(id, { action: "approve", repaymentMethod: "EFT" })).status).toBe(200)
    const back = await decide(id, { action: "return_to_review", reason: reviewReason, returnReason: reviewReason })
    const row = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect({ s: back.status, st: row.status, election: row.creditLifeElection }).toEqual({ s: 200, st: "UNDER_REVIEW", election: null })
  })
})
