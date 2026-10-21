/**
 * Real-Postgres proof of the outcome job (migration 20261021120000_decision_outcome):
 * the cron route refuses a call without the secret and writes nothing; with
 * it, each lender's approval gets its outcomes under its own tenant; a second
 * run leaves every row exactly as it was; the unique key, the CHECKs and the
 * tenant-carrying foreign key refuse what the code never writes; and a
 * lender's run, as a role RLS binds, neither reads nor writes another lender's
 * rows. Every person, lender and amount is synthetic.
 *
 *   RUN_DECISION_OUTCOMES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/learning-loop/outcomes/outcomes.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { GET } from "@/app/api/cron/decision-outcomes/route"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { recordDecisions, type DecisionLogDb } from "../decision-log"
import { consumerApprovalRecords } from "../records"
import { credaflowOutcomeAdapter, type CredaflowOutcomeDb } from "./credaflow-adapter"
import { OUTCOME_DEFINITION_VERSION } from "./definition"
import { runTenantDecisionOutcomes } from "./job"
import { tenantOutcomeMetrics, type MetricsDb } from "./metrics-db"
import type { OutcomeWriterDb } from "./writer"

const suite = process.env.RUN_DECISION_OUTCOMES_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const ROLE = "cf_decision_outcomes_it"
const CRON_SECRET = "decision-outcomes-it-cron-secret"
const call = (secret?: string) => GET(new NextRequest("http://localhost/api/cron/decision-outcomes",
  secret === undefined ? {} : { headers: { "x-cron-secret": secret } }))

interface Lender { tenantId: string; loanId: string; approvalId: string; offerId: string }
const lenders: Lender[] = []
let app: ReturnType<typeof createAppPrismaClient>

async function lender(withHistory: boolean): Promise<Lender> {
  const tenant = await createChargesTenant(db, false)
  const { loanId, clientId } = await createChargesLoan(db, tenant)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { applicationId: true, createdAt: true } })
  await db.$transaction((tx) => recordDecisions(tx as unknown as DecisionLogDb, consumerApprovalRecords({
    tenantId: tenant.tenantId, applicationId: loan.applicationId, clientId, actor: { userId: tenant.userId, role: "LOAN_ADMIN" },
    decidedAt: new Date(loan.createdAt.getTime() - 60_000),
    productType: "MICRO", interestRatePm: 0.05, principalCents: 200_000, termDays: 31, instalmentCents: 216_900,
    creditLifePremiumCents: 0, repaymentMethod: "DEBIT_ORDER", monthlyIncomeCents: 2_000_000,
    thresholds: { bureauMinScore: 580, bureauBlockAdverse: false, ndiBufferPct: 110, bureauMaxAgeDays: 60 },
    bureau: { id: "bureau-it", provider: "experian", score: 640, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false, hasJudgement: false, hasNotice: false, obligations: { totalMonthly: 0 } },
    bureauGateBlocked: false, bureauOverrideReason: null,
    affordability: { ndiCents: 600_000, requiredNdiCents: 300_000 }, screeningState: "CLEAR", creditCheckFlags: [],
    affordabilitySnapshot: { policyVersion: "approval-ndi-v3", inputFingerprint: "a".repeat(64), decisionFingerprint: "b".repeat(64) },
  })))
  const records = await db.creditDecisionRecord.findMany({ where: { tenantId: tenant.tenantId }, select: { id: true, kind: true } })
  if (withHistory) {
    // Every day of the fixture's term + 30 days (bullet due 1 Sep 2026), DPD climbing from the due day.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      tenantId: tenant.tenantId, loanId, snapshotDate: new Date(Date.UTC(2026, 8, 1 + i)), status: "ACTIVE" as const,
      ncaRegime: "NCA" as const, collectionsStage: "NONE" as const, daysInArrears: i, arrearsCents: i === 0 ? 0 : 216_900,
      outstandingPrincipalCents: 200_000, chargesOutstandingCents: 0, chargesLive: false,
    }))
    await db.loanArrearsSnapshot.createMany({ data: rows })
    await returnedDebitOrders(tenant.tenantId, tenant.userId, loanId, clientId)
  }
  return {
    tenantId: tenant.tenantId, loanId,
    approvalId: records.find((r) => r.kind === "CREDIT_DECISION")!.id,
    offerId: records.find((r) => r.kind === "OFFER")!.id,
  }
}

/** One return the job keeps (UNPAID, its reason) and one it must ignore (reported after payment). */
async function returnedDebitOrders(tenantId: string, userId: string, loanId: string, clientId: string) {
  const schedule = await db.repaymentSchedule.findFirstOrThrow({ where: { loanId }, select: { id: true } })
  const mandate = await db.debitMandate.create({ data: {
    tenantId, loanId, clientId, provider: "simulated", authType: "TT1", amountCents: 216_900, maxAmountCents: 216_900,
    debitDay: 1, frequency: "MONTHLY", trackingDays: 3, firstCollectionDate: new Date("2026-09-01"),
    accountHolder: "Synthetic Holder", bankName: "Synthetic Bank", branchCode: "000000", accountNumber: "0000000000", accountType: "CURRENT",
    simulated: true, createdById: userId,
  } })
  // The mandate state machine: CREATED -> SUBMITTING -> ACTIVE.
  for (const status of ["SUBMITTING", "ACTIVE"] as const) await db.debitMandate.update({ where: { id: mandate.id }, data: { status } })
  for (const [n, afterPayment] of [[1, false], [2, true]] as const) {
    const instruction = await db.collectionInstruction.create({ data: {
      tenantId, mandateId: mandate.id, loanId, repaymentScheduleId: schedule.id, installmentNo: 1, presentmentNo: n,
      amountCents: 216_900, actionDate: new Date(`2026-09-0${n}`), trackingDays: 3, instructionRef: `it-${randomUUID()}`, status: "UNPAID",
    } })
    await db.collectionResult.create({ data: {
      tenantId, provider: "simulated", instructionId: instruction.id, resultKey: `${instruction.id}:UNPAID`, outcome: "UNPAID",
      reasonCode: afterPayment ? "ACCOUNT_CLOSED" : "INSUFFICIENT_FUNDS", rawPayload: {}, resolvedAt: new Date(`2026-09-0${n + 2}T08:00:00Z`),
      simulated: true, reportedAfterPayment: afterPayment,
    } })
  }
}

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`)
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

const rowsOf = (tenantId: string) => db.decisionOutcome.findMany({ where: { tenantId }, orderBy: { id: "asc" } })
const find = (rows: Awaited<ReturnType<typeof rowsOf>>, kind: string, window: string) => rows.filter((r) => r.outcomeKind === kind && r.window === window)

suite("decision outcomes (real Postgres)", () => {
  const saved = process.env.CRON_SECRET

  beforeAll(async () => {
    process.env.CRON_SECRET = CRON_SECRET
    lenders.push(await lender(true), await lender(false))
  }, 120_000)

  afterAll(async () => {
    if (saved === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = saved
    vi.unstubAllEnvs()
    await app?.$disconnect()
    await db.$disconnect()
  })

  it("answers 401 without the secret and writes nothing", async () => {
    expect((await call()).status).toBe(401)
    expect((await call("x".repeat(CRON_SECRET.length))).status).toBe(401)
    for (const l of lenders) expect(await db.decisionOutcome.count({ where: { tenantId: l.tenantId } })).toBe(0)
  })

  it("derives each lender's outcomes under its own tenant, attached to its own approval and offer", async () => {
    const res = await call(CRON_SECRET)
    // Other suites' tenants share this database; ours must have run.
    expect(res.status).not.toBe(500)
    const body = await res.json() as { perTenant: Array<{ tenantId: string; error?: string }> }
    for (const l of lenders) expect(body.perTenant.find((t) => t.tenantId === l.tenantId)?.error).toBeUndefined()

    const [a, b] = [await rowsOf(lenders[0].tenantId), await rowsOf(lenders[1].tenantId)]
    for (const [rows, l] of [[a, lenders[0]], [b, lenders[1]]] as const) {
      expect(rows.length).toBeGreaterThan(0)
      expect(new Set(rows.map((r) => r.decisionRecordId))).toEqual(new Set([l.approvalId, l.offerId]))
      expect(rows.every((r) => r.sourceSystem === "credaflow" && r.definitionVersion === OUTCOME_DEFINITION_VERSION)).toBe(true)
      expect(find(rows, "TAKEN_UP", "OFFER")).toMatchObject([{ decisionRecordId: l.offerId, state: "OBSERVED", value: true }])
      // Bullet due 1 Sep, never paid; the run is after 1 Oct.
      expect(find(rows, "PAID", "INSTALMENT:1")).toMatchObject([{ state: "OBSERVED", value: false }])
      expect(find(rows, "LATE", "INSTALMENT:1")).toMatchObject([{ state: "OBSERVED", value: false }])
    }
    // Lender A has every day of its term + 30 days recorded; lender B has none, which is never read as good.
    expect(find(a, "EVER_30_DPD", "TERM_30D")).toMatchObject([{ state: "OBSERVED", value: false }])
    expect(find(b, "EVER_30_DPD", "TERM_30D")).toMatchObject([{ state: "UNOBSERVABLE", value: null, reasonCode: "HISTORY_GAP" }])
    expect(find(a, "RETURNED_DEBIT_ORDER", "INSTALMENT:1")).toMatchObject([{ value: true, reasonCode: "INSUFFICIENT_FUNDS", amountCents: 216_900 }])
    expect(find(b, "RETURNED_DEBIT_ORDER", "INSTALMENT:1")).toEqual([])
    expect(find(a, "EVER_90_DPD", "12M")).toMatchObject([{ state: "PENDING", value: null }])
  })

  it("is idempotent: a second run leaves every row exactly as it was", async () => {
    const before = await Promise.all(lenders.map((l) => rowsOf(l.tenantId)))
    expect((await call(CRON_SECRET)).status).not.toBe(500)
    expect(await Promise.all(lenders.map((l) => rowsOf(l.tenantId)))).toEqual(before)
  })

  it("refuses a second row on the same key, and rows the code never writes", async () => {
    const [row] = await rowsOf(lenders[0].tenantId)
    const { id: _id, ...copy } = row
    await expect(db.decisionOutcome.create({ data: copy })).rejects.toThrow(/Unique constraint/)
    const pending = { ...copy, sourceRef: `x-${randomUUID()}`, state: "PENDING" as const, value: null, observedAt: null }
    await expect(db.decisionOutcome.create({ data: { ...pending, value: false } })).rejects.toThrow("DecisionOutcome_value_when_observed")
    await expect(db.decisionOutcome.create({ data: { ...pending, sourceSystem: "some_lender" } })).rejects.toThrow("DecisionOutcome_source_system")
    await expect(db.decisionOutcome.create({ data: { ...pending, window: "24M" } })).rejects.toThrow("DecisionOutcome_window")
    // Lender B's outcome cannot hang off lender A's decision: the foreign key carries the tenant.
    await expect(db.decisionOutcome.create({ data: { ...pending, tenantId: lenders[1].tenantId } })).rejects.toThrow(/Foreign key constraint/)
    await db.decisionOutcome.create({ data: pending })
    await db.decisionOutcome.delete({ where: { id: (await db.decisionOutcome.findFirstOrThrow({ where: { sourceRef: pending.sourceRef } })).id } })
  })

  it("runs one lender, as a role RLS binds, without reading or writing another lender's rows", async () => {
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(await createAppRole())
    const [me] = await app.$queryRaw<{ su: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })

    const [a, b] = lenders
    await db.decisionOutcome.deleteMany({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } })
    const runs = await runWithTenant(a.tenantId, () => runTenantDecisionOutcomes(a.tenantId, new Date(),
      [credaflowOutcomeAdapter(app as unknown as CredaflowOutcomeDb)], app as unknown as OutcomeWriterDb))
    expect(runs[0].decisions).toBe(2)
    expect(await db.decisionOutcome.count({ where: { tenantId: b.tenantId } })).toBe(0)
    expect(new Set((await rowsOf(a.tenantId)).map((r) => r.decisionRecordId))).toEqual(new Set([a.approvalId, a.offerId]))

    const asB = await runWithTenant(b.tenantId, async () => ({
      rows: await app.decisionOutcome.count(),
      raw: await app.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "DecisionOutcome" WHERE "tenantId" = ${a.tenantId}`,
    }))
    expect(asB).toEqual({ rows: 0, raw: [{ n: 0 }] })
    await expect(runWithTenant(b.tenantId, async () => await app.$executeRaw`
      INSERT INTO "DecisionOutcome" ("id", "tenantId", "decisionRecordId", "outcomeKind", "window", "state", "sourceSystem", "sourceRef", "definitionVersion", "computedAt")
      VALUES (${randomUUID()}, ${a.tenantId}, ${a.approvalId}, 'SETTLED', '3M', 'PENDING', 'credaflow', 'x', 'v', now())`))
      .rejects.toThrow(/row-level security/)
  })

  it("reports coverage per decision month and an empty calibration (no decision carries a probability)", async () => {
    const term = await runWithTenant(lenders[0].tenantId, () => tenantOutcomeMetrics(app as unknown as MetricsDb, { outcomeKind: "EVER_30_DPD", window: "TERM_30D" }))
    expect(term.coverage).toMatchObject([{ decisionKind: "CREDIT_DECISION", decisions: 1, matured: 1, observed: 1, coveragePct: 100 }])
    expect(term.calibration).toEqual([])
    const headline = await runWithTenant(lenders[0].tenantId, () => tenantOutcomeMetrics(app as unknown as MetricsDb))
    expect(headline.coverage).toMatchObject([{ decisions: 1, pending: 1, matured: 0, coveragePct: null }])
  })
})
