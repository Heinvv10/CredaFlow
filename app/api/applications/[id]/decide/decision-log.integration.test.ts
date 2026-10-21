/**
 * Real-Postgres proof that the consumer decide route writes its decision-log
 * rows (CreditDecisionRecord, migration 20261021090000_credit_decision_record)
 * in the same transaction as the decision and its audit row, under a role
 * row-level security binds (neither superuser nor BYPASSRLS), through the
 * production client (`createAppPrismaClient`: tenant-scope extension and RLS
 * hook), as lib/learning-loop/decision-log.integration.test.ts does.
 *
 * Every approval gate runs for real against fixture rows: the submission
 * snapshot, composite KYC (four verified core documents), the credit-life
 * no-offer disclosure, compliance evidence, a current Experian check bound to
 * the subject under an in-band score floor (TenantConfig.bureauMinScore), the
 * NCA cap (a short-term loan, so no repo rate is needed), Regulation 23A
 * expenses, screening (off: no provider configured), the credit-check
 * recompute (the real recompute raises NO_STATEMENT in setup and an officer
 * clears it with a reason), the locked re-verification and every
 * LoanApplication trigger.
 *
 * Mocked, and why:
 *   - `@/lib/prisma`: `prisma` is replaced by the RLS-bound app client (a lazy
 *     proxy, since the role is created in beforeAll). Nothing else changes.
 *   - `@/lib/auth-guards` `requireApiRole`: the session (a LOAN_ADMIN with a
 *     TOTP-verified sign-in); `canDo` stays real.
 *   - `@/lib/auth` `auth`: a stub returning no session, never reached (the
 *     guard is mocked); NextAuth does not load under vitest, as in
 *     lib/asset-finance/recovery-gaps-rls.integration.test.ts.
 *   - `@/lib/tenant` `withTenantContext`: resolves this suite's tenant and runs
 *     the handler in its `runWithTenant` frame, as the real one does after
 *     host and session checks this suite does not exercise.
 *   - `@/lib/notifications` `triggerNotification`: no outbound email/WhatsApp.
 *
 *   RUN_DECISION_LOG_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run 'app/api/applications/[id]/decide/decision-log.integration.test.ts'
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
// NextAuth itself does not load under vitest (next/server resolution); the guard above it is mocked anyway.
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
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Decide log IT", domain: null, status: "ACTIVE" })),
  }
})
const notify = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications")>()),
  triggerNotification: notify,
}))

import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createSubmissionAffordabilitySnapshot, withAffordabilitySnapshot } from "@/lib/affordability/snapshot"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { POST } from "./route"

const RUN = process.env.RUN_DECISION_LOG_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const ROLE = "cf_decide_log_it"
const t = randomUUID().replaceAll("-", "").slice(0, 12)
const ids = {
  tenant: `decide-log-${t}`, officer: `decide-log-officer-${t}`, product: `decide-log-product-${t}`,
  approve: `decide-log-approve-${t}`, decline: `decide-log-decline-${t}`,
}
// One active application per client and product (a unique index), so each decision has its own borrower.
const clientOf = (applicationId: string) => `${applicationId}-client`
const db = new PrismaClient()
let app: ReturnType<typeof createAppPrismaClient> | undefined

// A R5,000 30-day micro loan: short-term credit, so the NCA cap is the flat 5% a month.
const product = {
  productType: "MICRO" as const, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL" as const,
  initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900,
}
const terms = { appliedAmount: 500_000, appliedTermDays: 30 }
const expenses = { housing: 400_000, transport: 150_000, food: 150_000, insurance: 50_000, medical: 50_000 }
const longAgo = new Date(Date.now() - 2 * 365 * 86_400_000)

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

/**
 * A borrower with the four core KYC documents verified (origination-grade: no
 * selfie yet; payout needs one, approval does not), uploaded before the credit
 * checks' statement window so no reader runs, and an UNDER_REVIEW application
 * with intact submission, credit-life and compliance evidence and a current
 * bureau check bound to the borrower.
 */
async function underReview(id: string) {
  const clientId = clientOf(id)
  await db.client.create({
    data: {
      id: clientId, tenantId: ids.tenant, reference: `CLI-${id}`, idNumber: syntheticSaIdNumber(), firstName: "Synthetic", lastName: "Borrower",
      email: `${id}@test.invalid`, phone: "+27820000000", grossMonthlyIncome: 2_200_000, monthlyIncome: 2_000_000, monthlyExpenses: 800_000,
      expenseBreakdown: { create: expenses },
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
  const submittedAt = new Date(Date.now() - 60 * 60_000)
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
      subjectFingerprint: bureauSubjectFingerprint(client), provider: "experian", score: 640, riskGrade: "LOW",
      adverseInfo: [], declineReasons: [], obligations: { totalMonthly: 0 }, ok: true,
    },
  })
}

function decide(id: string, fields: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  const req = new NextRequest(`http://localhost/api/applications/${id}/decide`, { method: "POST", body: form })
  return POST(req, { params: Promise.resolve({ id }) })
}

const recordsOf = (applicationId: string) => db.creditDecisionRecord.findMany({ where: { tenantId: ids.tenant, applicationId }, orderBy: { kind: "asc" } })
const auditsOf = (applicationId: string, action: string) => db.auditLog.count({ where: { tenantId: ids.tenant, entityId: applicationId, action } })

suite("consumer decide route: decision log under row-level security (real Postgres)", () => {
  beforeAll(async () => {
    holder.tenantId = ids.tenant
    holder.userId = ids.officer
    await db.tenant.create({ data: { id: ids.tenant, slug: ids.tenant, name: "Decide log IT" } })
    // An in-band (Experian Sigma) score floor: the default 450 is uncalibrated and refers every approval.
    await db.tenantConfig.create({ data: { tenantId: ids.tenant, bureauMinScore: 580 } })
    await db.user.create({ data: { id: ids.officer, tenantId: ids.tenant, email: `${ids.officer}@test.invalid`, password: "not-a-real-login", name: "Synthetic Officer", role: "LOAN_ADMIN" } })
    await db.loanProduct.create({
      data: { id: ids.product, tenantId: ids.tenant, code: `DL-${t}`, name: "Decide log micro", minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, ...product },
    })
    await underReview(ids.approve)
    await underReview(ids.decline)
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(roleUrl(await createAppRole()))
    holder.app = app
    // The real recompute raises its findings (no statement or payslip in the window); an officer clears each with a reason.
    await runWithTenant(ids.tenant, () => recomputeApplicationFlags(ids.tenant, ids.approve, { userId: ids.officer }))
    await db.applicationCheckFlag.updateMany({
      where: { tenantId: ids.tenant, applicationId: ids.approve, status: "OPEN" },
      data: { status: "CLEARED", clearedById: ids.officer, clearedAt: new Date(), clearReason: "Synthetic: income verified by other means." },
    })
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    holder.app = null
    await app?.$disconnect()
    const tenantId = ids.tenant
    // CreditDecisionRecord is append-only; the replica role skips its trigger, as cleanupDealFixture does.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.creditDecisionRecord.deleteMany({ where: { tenantId } }),
      db.auditLog.deleteMany({ where: { tenantId } }),
      db.webhookEvent.deleteMany({ where: { tenantId } }),
      db.applicationCheckFlag.deleteMany({ where: { tenantId } }),
      db.creditBureauCheck.deleteMany({ where: { tenantId } }),
      db.loanApplication.deleteMany({ where: { tenantId } }),
      db.clientDocument.deleteMany({ where: { tenantId } }),
      db.clientExpenseBreakdown.deleteMany({ where: { client: { tenantId } } }),
      db.client.deleteMany({ where: { tenantId } }),
      db.loanProduct.deleteMany({ where: { tenantId } }),
      db.user.deleteMany({ where: { tenantId } }),
      db.tenantConfig.deleteMany({ where: { tenantId } }),
      db.tenant.deleteMany({ where: { id: tenantId } }),
    ])
    // DROP OWNED fails on a role that was never created (setup failed before it).
    if ((await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`).length > 0) {
      await db.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`)
      await db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`)
    }
    await db.$disconnect()
  }, 60_000)

  it("runs the route as a role row-level security binds (otherwise it proves nothing)", async () => {
    const [me] = await app!.$queryRaw<{ su: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
  })

  it("approves, and commits the approval, its audit row, the decision and its offer together", async () => {
    const res = await decide(ids.approve, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    expect((await db.loanApplication.findUniqueOrThrow({ where: { id: ids.approve } })).status).toBe("APPROVED")
    expect(await auditsOf(ids.approve, "LOAN_APPROVED")).toBe(1)
    const rows = await recordsOf(ids.approve)
    expect(rows.map((r) => [r.kind, r.decision, r.recommendation, r.overridden, r.clientId, r.actorType, r.actorUserId])).toEqual([
      ["CREDIT_DECISION", "APPROVE", "PASS", false, clientOf(ids.approve), "STAFF", ids.officer],
      ["OFFER", "APPROVED_TERMS", "NONE", false, clientOf(ids.approve), "STAFF", ids.officer],
    ])
    // The flags the real recompute raised, and the officer cleared, reach the record.
    const cleared = await db.applicationCheckFlag.count({ where: { tenantId: ids.tenant, applicationId: ids.approve, status: "CLEARED" } })
    expect(cleared).toBeGreaterThan(0)
    expect(rows[0].inputsSnapshot).toMatchObject({ bureau: { gate: "PASS" }, creditChecks: { cleared } })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: "loan_approved", loanId: ids.approve }))
  })

  it("declines, and commits the decline, its audit row and the decision together", async () => {
    const note = "Synthetic internal note that must never reach the log."
    const res = await decide(ids.decline, { action: "decline", declineCategory: "AFFORDABILITY", internalNote: note })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    expect((await db.loanApplication.findUniqueOrThrow({ where: { id: ids.decline } })).status).toBe("DECLINED")
    expect(await auditsOf(ids.decline, "LOAN_DECLINED")).toBe(1)
    const rows = await recordsOf(ids.decline)
    expect(rows.map((r) => [r.kind, r.decision, r.recommendation, r.overridden, r.clientId, r.actorUserId])).toEqual([
      ["CREDIT_DECISION", "DECLINE", "NONE", false, clientOf(ids.decline), ids.officer],
    ])
    expect(rows[0].inputsSnapshot).toEqual({ declineCategory: "AFFORDABILITY" })
    expect(JSON.stringify(rows[0])).not.toContain(note)
  })
})
