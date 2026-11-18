/**
 * PR #277 breaker. Each test asserts the SAFE behaviour: RED = the control is broken, GREEN = it holds.
 * Run from a clone at 0cc59913, copied to app/api/applications/[id]/decide/:
 *   RUN_DB_IT=1 DATABASE_URL=... npx vitest run --testTimeout=60000 --hookTimeout=240000 'app/api/applications/[id]/decide/brk277-attacks.integration.test.ts'
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
    await db().tenantConfig.create({ data: { tenantId: tenant, bureauMinScore: 580 } })
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
suite("attacks on a Lesotho instance", () => {
  beforeAll(() => ls.setup(), 240_000)
  afterAll(() => ls.teardown(), 60_000)

  it("E1 a LIVE engine must not auto-approve a KEY_FACTS application nobody bureau-checked on SA-style bureau rules", async () => {
    await ls.change(RULE_SET_KIND, "rules", ruleSet)
    await ls.change(ENGINE_CONFIG_KIND, "live", engine())
    const id = `e1-${t}`
    await ls.underReview(id, { generation: true })
    await ls.clearFlags(id)
    const outcome = await runAutoDecision({ tenantId: ls.tenant, applicationId: id, trigger: "MANUAL" })
    const row = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect({ outcome: outcome.status === "RAN" ? outcome.execution : outcome.reason, status: row.status }).toEqual({ outcome: "REFERRED", status: "UNDER_REVIEW" })
  })

  it("M1 the Reg 23A rule 'still applies to both' (.claude.md): an unjustified R50 expense declaration must be refused", async () => {
    const id = `m1-${t}`
    await ls.underReview(id, { expenses: { housing: 1_000, transport: 1_000, food: 1_000, insurance: 1_000, medical: 1_000 } })
    await ls.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect({ status: res.status, body: await res.json() }).toMatchObject({ status: 422, body: { mleJustificationMissing: true } })
  })

  it("S1 screening must actually run for a KEY_FACTS approval: no provider means no sanctions or PEP check at all", async () => {
    const id = `s1-${t}`
    await ls.underReview(id)
    await ls.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status, "approved with screening NOT_CONFIGURED and no bureau").not.toBe(200)
  })

  it("O1 a bureau override on KEY_FACTS must not stamp an s81 assessment nobody made", async () => {
    const id = `o1-${t}`
    await ls.underReview(id)
    await ls.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT", bureauOverrideReason: "Synthetic override reason, long enough for the minimum length." })
    const row = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect({ status: res.status, assessed: row.recklessLendingAssessed }).toEqual({ status: 200, assessed: false })
  })

  it("C1 ACCEPTED credit life is refused at decide", async () => {
    const id = `c1-${t}`
    await ls.underReview(id)
    const c = await cover(ls.db(), ls.tenant, id)
    await ls.db().loanApplication.update({ where: { id }, data: { creditLifeElection: "ACCEPTED", creditLifeProductId: c.productId, creditLifeProductName: "Synthetic Cover", creditLifeInsurerId: c.insurerId, creditLifeInsurerName: c.insurerName, creditLifeMonthlyPremiumCents: 25_000, creditLifeDisclosureVersion: "credit-life-election-v1", creditLifeDisclosureSha256: "a".repeat(64), creditLifeDisclosureAcknowledgedAt: new Date(), creditLifeDisclosureAcknowledgedBy: `${id}-client` } })
    await ls.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ creditLifeEvidence: "not_offered" })
  })

  it("C2 the database refuses a premium on a no-offer election", async () => {
    const id = `c2-${t}`
    await ls.underReview(id, { noOffer: true })
    await expect(ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "creditLifeMonthlyPremiumCents" = 25000 WHERE id = '${id}'`)).rejects.toThrow(/election_complete/)
  })

  it("D1a the database must refuse a direct KEY_FACTS approval with no approval snapshot at all", async () => {
    const id = `d1a-${t}`
    await ls.underReview(id)
    const err = await ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = '${ids.officer}', "approvedAmount" = 500000, "approvedTermDays" = 30, "approvedRate" = 0.05, "repaymentMethod" = 'EFT', "affordabilityResult" = '{}' WHERE id = '${id}'`).then(() => "ACCEPTED BY DB", (e: Error) => e.message)
    dbMsg("D1a", err)
    expect(err.slice(-200)).not.toBe("ACCEPTED BY DB")
  })

  it("D1b the database must refuse a direct KEY_FACTS approval carrying ACCEPTED cover", async () => {
    const id = `d1b-${t}`
    await ls.underReview(id)
    const c = await cover(ls.db(), ls.tenant, id)
    const err = await ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "creditLifeElection" = 'ACCEPTED', "creditLifeProductId" = '${c.productId}', "creditLifeProductName" = 'Synthetic Cover', "creditLifeInsurerId" = '${c.insurerId}', "creditLifeInsurerName" = '${c.insurerName}', "creditLifeMonthlyPremiumCents" = 25000, "creditLifeDisclosureVersion" = 'credit-life-election-v1', "creditLifeDisclosureSha256" = '${"a".repeat(64)}', "creditLifeDisclosureAcknowledgedAt" = now(), "creditLifeDisclosureAcknowledgedBy" = '${id}-client', status = 'APPROVED', "approvedAt" = now(), "approvedById" = '${ids.officer}', "approvedAmount" = 500000, "approvedTermDays" = 30, "approvedRate" = 0.05, "repaymentMethod" = 'EFT' WHERE id = '${id}'`).then(() => "ACCEPTED BY DB", (e: Error) => e.message)
    dbMsg("D1b", err)
    expect(err.slice(-200)).not.toBe("ACCEPTED BY DB")
  })

  it("D2 approved KEY_FACTS terms and evidence must be frozen in the database after approval", async () => {
    const id = `d2-${t}`
    await ls.underReview(id)
    await ls.clearFlags(id)
    expect((await decide(id, { action: "approve", repaymentMethod: "EFT" })).status).toBe(200)
    const err = await ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "approvedAmount" = 800000, "approvedRate" = 0.2, "affordabilityResult" = '{}' WHERE id = '${id}'`).then(() => "ACCEPTED BY DB", (e: Error) => e.message)
    dbMsg("D2", err)
    expect(err.slice(-200)).not.toBe("ACCEPTED BY DB")
  })

  it("D2b approved KEY_FACTS amount and rate alone must be frozen in the database", async () => {
    const id = `d2b-${t}`
    await ls.underReview(id)
    await ls.clearFlags(id)
    expect((await decide(id, { action: "approve", repaymentMethod: "EFT" })).status).toBe(200)
    const err = await ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "approvedAmount" = 800000, "approvedRate" = 0.2 WHERE id = '${id}'`).then(() => "ACCEPTED BY DB", (e: Error) => e.message)
    dbMsg("D2b", err)
    expect(err.slice(-200)).not.toBe("ACCEPTED BY DB")
  })

  it("T1 a client the lender itself recorded as deceased must not be approved (the bureau was the only deceased gate)", async () => {
    const id = `t1-${t}`
    await ls.underReview(id)
    await ls.db().client.update({ where: { id: `${id}-client` }, data: { deceasedAt: new Date(), deceasedReason: "Synthetic" } })
    await ls.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status).not.toBe(200)
  })

  it("P1 payout re-verification fails closed on a KEY_FACTS approval (nothing pays out on it yet)", async () => {
    const id = `p1-${t}`
    await ls.underReview(id)
    await ls.clearFlags(id)
    expect((await decide(id, { action: "approve", repaymentMethod: "EFT" })).status).toBe(200)
    const result = await runWithTenant(ls.tenant, () => prisma.$transaction((tx) => verifyLockedCurrentAffordabilityApproval(tx as never, { tenantId: ls.tenant, applicationId: id })))
    expect(result).toMatchObject({ ok: false })
  })

  it("B1 the real bureau step makes no enquiry for KEY_FACTS and the real review shape (generation, no-offer disclosure) approves", async () => {
    const id = `b1-${t}`
    const application = await ls.underReview(id, { generation: true, noOffer: true })
    const result = await runWithTenant(ls.tenant, () => runBureauReviewCheck({ tenantId: ls.tenant, applicationId: id, clientId: application.clientId!, reviewGeneration: application.bureauReviewGeneration! }))
    expect(result).toBe("skipped")
    expect(await ls.db().creditBureauCheck.count({ where: { tenantId: ls.tenant, applicationId: id } })).toBe(0)
    await ls.clearFlags(id)
    expect((await decide(id, { action: "approve", repaymentMethod: "EFT" })).status).toBe(200)
  })

  it("R1 a client cannot make a KEY_FACTS row NCA_PASQ or back, and the instance cannot move once frozen", async () => {
    const id = `r1-${t}`
    await ls.underReview(id)
    await expect(ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "disclosureRegime" = 'NCA_PASQ' WHERE id = '${id}'`)).rejects.toThrow(/fixed when it is created/)
    await expect(ls.db().instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "ZA", currency: "ZAR" } })).rejects.toThrow()
  })

  it("X1 a KEY_FACTS row in a process wrongly on ZA is still decided by its stored regime", async () => {
    const id = `x1-${t}`
    await ls.underReview(id)
    await ls.clearFlags(id)
    setActiveJurisdiction({ jurisdiction: "ZA", currency: "ZAR" })
    try {
      const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
      expect(res.status, "regime, not the process").toBe(200)
    } finally {
      setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    }
  })

  it("A1 the approval matrix still runs for KEY_FACTS and the engine still cannot approve past it", async () => {
    await ls.change(MATRIX_KIND, "matrix", matrix)
    const id = `a1-${t}`
    await ls.underReview(id, { generation: true })
    await ls.clearFlags(id)
    const engineOutcome = await runAutoDecision({ tenantId: ls.tenant, applicationId: id, trigger: "MANUAL" })
    expect(engineOutcome.status === "RAN" ? engineOutcome.execution : engineOutcome.reason).toBe("REFERRED")
    const staff = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect((await staff.clone().json()).error ?? "", JSON.stringify(await staff.json())).toBeDefined()
    expect((await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })).status).toBe("UNDER_REVIEW")
    expect(await ls.db().approvalStep.count({ where: { tenantId: ls.tenant, applicationId: id } })).toBe(1)
    await expect(ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = '${ids.officer}' WHERE id = '${id}'`)).rejects.toThrow()
  })
})

const za = instanceSuite("ZA")
suite("attacks on a South African instance", () => {
  beforeAll(() => za.setup(), 240_000)
  afterAll(() => za.teardown(), 60_000)

  it("Z1 a caller cannot stamp KEY_FACTS at insert or by update", async () => {
    const application = await za.underReview(`z1-${t}`, { nca: true })
    expect(application.disclosureRegime).toBe("NCA_PASQ")
    await expect(za.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "disclosureRegime" = 'KEY_FACTS' WHERE id = 'z1-${t}'`)).rejects.toThrow(/fixed when it is created/)
    const clientId = (await za.underReview(`z1b-${t}`, { nca: true })).clientId
    const other = await za.db().loanProduct.create({ data: { id: `${ids.product}-2`, tenantId: za.tenant, code: `BRK2-${t}`, name: "other", minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, ...product } })
    const raw = await za.db().loanApplication.create({ data: { tenantId: za.tenant, reference: `APP-z1c-${t}`, clientId: clientId!, productId: other.id, ...terms, submittedAt: new Date(), status: "SUBMITTED", disclosureRegime: "KEY_FACTS", existingDebtObligations: [] } }).catch((e: Error) => { throw new Error(e.message.slice(-300)) })
    expect(raw.disclosureRegime).toBe("NCA_PASQ")
  })

  it("Z2 an NCA_PASQ row decided by a process on LS still needs every item: created under one jurisdiction, decided under another", async () => {
    const id = `z2-${t}`
    await za.underReview(id, { nca: true })
    await za.db().loanApplication.update({ where: { id }, data: { clientAffordabilityDeclaredAt: null, recklessLendingAssessed: false, recklessLendingAssessedAt: null, recklessLendingAssessedById: null } })
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    try {
      const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ missingComplianceEvidence: ["client affordability declaration", "reckless-lending assessment"] })
      const id3 = `z2b-${t}`
      await za.underReview(id3, { nca: true })
      const bureau = await decide(id3, { action: "approve", repaymentMethod: "EFT" })
      expect(await bureau.json()).toMatchObject({ bureauMissing: true })
    } finally {
      setActiveJurisdiction({ jurisdiction: "ZA", currency: "ZAR" })
    }
  })

  it("Z5 control: does the database refuse the D1a direct approval of an NCA_PASQ row (no snapshot)?", async () => {
    const id = `z5-${t}`
    await za.underReview(id, { nca: true })
    const err = await za.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = '${ids.officer}', "approvedAmount" = 500000, "approvedTermDays" = 30, "approvedRate" = 0.05, "repaymentMethod" = 'EFT', "affordabilityResult" = '{}' WHERE id = '${id}'`).then(() => "ACCEPTED BY DB", (e: Error) => e.message)
    dbMsg("Z5", err)
    expect(err.slice(-200)).not.toBe("ACCEPTED BY DB")
  })

  it("Z6 control: are approved NCA amount and rate frozen where D2b found KEY_FACTS not?", async () => {
    const id = `z6-${t}`
    await za.underReview(id, { nca: true })
    await za.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT", bureauOverrideReason: "Synthetic override reason, long enough for the minimum length." })
    expect(res.status).toBe(200)
    const err = await za.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "approvedAmount" = 800000, "approvedRate" = 0.2 WHERE id = '${id}'`).then(() => "ACCEPTED BY DB", (e: Error) => e.message)
    dbMsg("Z6", err)
    expect(err.slice(-200)).not.toBe("ACCEPTED BY DB")
  })

  it("Z3 control: on ZA the same engine and rules refer a no-bureau application to staff", async () => {
    await za.change(RULE_SET_KIND, "rules", ruleSet)
    await za.change(ENGINE_CONFIG_KIND, "live", engine())
    const id = `z3-${t}`
    await za.underReview(id, { nca: true })
    await za.clearFlags(id)
    const outcome = await runAutoDecision({ tenantId: za.tenant, applicationId: id, trigger: "MANUAL" })
    expect(outcome.status === "RAN" ? outcome.execution : outcome.reason).toBe("REFERRED")
    expect((await za.db().loanApplication.findUniqueOrThrow({ where: { id } })).status).toBe("UNDER_REVIEW")
  })

  it("Z4 control: on ZA the MLE gate refuses the same R50 declaration", async () => {
    const id = `z4-${t}`
    await za.underReview(id, { nca: true, expenses: { housing: 1_000, transport: 1_000, food: 1_000, insurance: 1_000, medical: 1_000 } })
    await za.clearFlags(id)
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT", bureauOverrideReason: "Synthetic override reason, long enough for the minimum length." })
    expect(res.status, "refused earlier, at the submission evidence, on ZA").toBe(422)
  })
})
