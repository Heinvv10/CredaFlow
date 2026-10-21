/**
 * Real-Postgres proof of the decision-performance dashboard loader: two
 * lenders, each with a synthetic approval, offer, decline, outcomes, arrears
 * history and arrangement. Each lender's dashboard holds only its own rows,
 * read both by the migration owner (the explicit tenantId filters) and by a
 * role RLS binds (the policies), and the aggregates are the expected ones.
 * The 90+ book figure equals the board pack's (getBookArrears). Every person,
 * lender and amount is synthetic.
 *
 *   RUN_DECISION_DASHBOARD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/learning-loop/dashboard/dashboard.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createAppPrismaClient } from "@/lib/prisma"
import { getBookArrears } from "@/lib/reports/book-arrears"
import { recordDecisions, type DecisionLogDb } from "../decision-log"
import { OUTCOME_DEFINITION_VERSION } from "../outcomes/definition"
import { consumerApprovalRecords, consumerDeclineRecord } from "../records"
import { loadDecisionPerformance, type DashboardDb, type DecisionPerformance } from "./loader"

const suite = process.env.RUN_DECISION_DASHBOARD_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const ROLE = "cf_decision_dashboard_it"
const NOW = new Date("2026-10-21T10:00:00+02:00")

interface Lender { tenantId: string; loanId: string }
const lenders: Lender[] = []
let app: ReturnType<typeof createAppPrismaClient>

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000))

/** A: one bad approval (ever 90+ observed), a cured soft-reminder episode, a kept arrangement, 95 DPD now. B: pending, a stayed s129 episode, a broken arrangement. */
async function lender(bad: boolean): Promise<Lender> {
  const tenant = await createChargesTenant(db, false)
  const { loanId, clientId } = await createChargesLoan(db, tenant)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { applicationId: true, createdAt: true } })
  const actor = { userId: tenant.userId, role: "LOAN_ADMIN" }
  await db.$transaction(async (tx) => {
    await recordDecisions(tx as unknown as DecisionLogDb, consumerApprovalRecords({
      tenantId: tenant.tenantId, applicationId: loan.applicationId, clientId, actor,
      decidedAt: new Date(loan.createdAt.getTime() - 60_000),
      productType: "MICRO", interestRatePm: 0.05, principalCents: 200_000, termDays: 31, instalmentCents: 216_900,
      creditLifePremiumCents: 0, repaymentMethod: "DEBIT_ORDER", monthlyIncomeCents: 2_000_000,
      thresholds: { bureauMinScore: 580, bureauBlockAdverse: false, ndiBufferPct: 110, bureauMaxAgeDays: 60 },
      bureau: { id: "bureau-it", provider: "experian", score: 640, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false, hasJudgement: false, hasNotice: false, obligations: { totalMonthly: 0 } },
      bureauGateBlocked: false, bureauOverrideReason: null,
      affordability: { ndiCents: 600_000, requiredNdiCents: 300_000 }, screeningState: "CLEAR", creditCheckFlags: [],
      affordabilitySnapshot: { policyVersion: "approval-ndi-v3", inputFingerprint: "a".repeat(64), decisionFingerprint: "b".repeat(64) },
    }))
    await recordDecisions(tx as unknown as DecisionLogDb, [consumerDeclineRecord({
      tenantId: tenant.tenantId, applicationId: `app-declined-${randomUUID()}`, clientId: null, actor,
      decidedAt: new Date("2026-10-02T09:00:00+02:00"), declineCategory: bad ? "AFFORDABILITY" : "BUREAU_SCORE",
    })])
  })
  const records = await db.creditDecisionRecord.findMany({ where: { tenantId: tenant.tenantId, applicationId: loan.applicationId }, select: { id: true, kind: true } })
  const base = { tenantId: tenant.tenantId, sourceSystem: "credaflow", sourceRef: loanId, definitionVersion: OUTCOME_DEFINITION_VERSION, computedAt: NOW }
  const approvalId = records.find((r) => r.kind === "CREDIT_DECISION")!.id
  await db.decisionOutcome.createMany({ data: [
    bad
      ? { ...base, decisionRecordId: approvalId, outcomeKind: "EVER_90_DPD", window: "12M", state: "OBSERVED", value: true, observedAt: NOW }
      : { ...base, decisionRecordId: approvalId, outcomeKind: "EVER_90_DPD", window: "12M", state: "PENDING" },
    { ...base, decisionRecordId: approvalId, outcomeKind: "EVER_30_DPD", window: "3M", state: "UNOBSERVABLE", reasonCode: "HISTORY_GAP" },
    { ...base, decisionRecordId: records.find((r) => r.kind === "OFFER")!.id, outcomeKind: "TAKEN_UP", window: "OFFER", state: "OBSERVED", value: true, observedAt: NOW, sourceRef: loan.applicationId },
  ] })
  const snapshot = (snapshotDate: Date, daysInArrears: number, collectionsStage: "SOFT_REMINDER" | "SECTION_129_SENT") => ({
    tenantId: tenant.tenantId, loanId, snapshotDate, status: "ACTIVE" as const, ncaRegime: "NCA" as const, collectionsStage, daysInArrears,
    arrearsCents: daysInArrears > 0 ? 216_900 : 0, outstandingPrincipalCents: 200_000, chargesOutstandingCents: 0, chargesLive: false,
  })
  await db.loanArrearsSnapshot.createMany({ data: bad
    ? days("2026-06-01", 4).map((d, i) => snapshot(d, i < 3 ? 5 : 0, "SOFT_REMINDER"))
    : days("2026-06-01", 40).map((d) => snapshot(d, 35, "SECTION_129_SENT")) })
  await db.paymentArrangement.create({ data: {
    tenantId: tenant.tenantId, loanId, arrangementDate: new Date("2026-06-05"), agreedAmount: 50_000, frequency: "MONTHLY",
    startDate: new Date("2026-06-05"), endDate: new Date("2026-08-05"), status: bad ? "KEPT" : "BROKEN",
  } })
  if (bad) await db.loan.update({ where: { id: loanId }, data: { daysInArrears: 95, arrearsAmount: 216_900 } })
  return { tenantId: tenant.tenantId, loanId }
}

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

function expectLender(d: DecisionPerformance, bad: boolean) {
  expect(d.approvals).toBe(1)
  expect(d.cohorts).toHaveLength(1)
  expect(d.cohorts[0]).toMatchObject({ loans: 1, small: true, scoreBand: "630-679", overridden: false, product: "MICRO" })
  expect(d.totals.ever90).toMatchObject(bad
    ? { n: 1, yes: 1, no: 0, pending: 0, ratePct: 100, coveragePct: 100 }
    : { n: 1, yes: 0, no: 0, pending: 1, ratePct: null, coveragePct: null })
  expect(d.takeUp).toMatchObject([{ decision: "APPROVED_TERMS", offers: 1, takeUp: { yes: 1, ratePct: 100 } }])
  expect(d.declines).toMatchObject({ total: 1, automated: 0, byCategory: { [bad ? "AFFORDABILITY" : "BUREAU_SCORE"]: 1 } })
  expect(d.stages).toMatchObject([bad
    ? { stage: "SOFT_REMINDER", loans: 1, cured: 1, rolled: 0, cureRatePct: 100 }
    : { stage: "SECTION_129_SENT", loans: 1, stayed: 1, cured: 0, cureRatePct: 0 }])
  expect(d.arrangements).toMatchObject(bad ? { total: 1, kept: 1, broken: 0 } : { total: 1, kept: 0, broken: 1 })
  expect(d.book.par90.count).toBe(bad ? 1 : 0)
}

suite("decision-performance dashboard (real Postgres)", () => {
  beforeAll(async () => {
    lenders.push(await lender(true), await lender(false))
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.$disconnect()
    await db.$disconnect()
  })

  it("loads each lender's own aggregates through the explicit tenant filters", async () => {
    const [a, b] = lenders
    expectLender(await loadDecisionPerformance(db as unknown as DashboardDb, a.tenantId, NOW, "12M"), true)
    expectLender(await loadDecisionPerformance(db as unknown as DashboardDb, b.tenantId, NOW, "12M"), false)
  })

  it("matches the board pack's 90+ figure for the lender", async () => {
    const [a] = lenders
    const d = await loadDecisionPerformance(db as unknown as DashboardDb, a.tenantId, NOW, "12M")
    expect(d.book).toEqual(await getBookArrears(a.tenantId, "ALL", db as unknown as Parameters<typeof getBookArrears>[2]))
  })

  it("as a role RLS binds, returns the same figures and never another lender's rows", async () => {
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(await createAppRole())
    const [me] = await app.$queryRaw<{ su: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
    const [a, b] = lenders
    expectLender(await loadDecisionPerformance(app as unknown as DashboardDb, a.tenantId, NOW, "12M"), true)
    expectLender(await loadDecisionPerformance(app as unknown as DashboardDb, b.tenantId, NOW, "12M"), false)
  })

  it("reads the asked window only: the 3M gap is unobservable, never good", async () => {
    const d = await loadDecisionPerformance(db as unknown as DashboardDb, lenders[0].tenantId, NOW, "3M")
    expect(d.totals.ever30).toMatchObject({ n: 1, yes: 0, no: 0, unobservable: 1, ratePct: null, coveragePct: 0 })
    // 3M does not measure 90+ DPD (DESIGN.md §3): not a gap, no row expected.
    expect(d.totals.ever90).toBeNull()
  })
})
