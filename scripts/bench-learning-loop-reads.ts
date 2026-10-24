/**
 * Benchmark: what the nightly outcome job and the decision-performance loader
 * read from a synthetic book (lib/learning-loop/outcomes/credaflow-adapter.ts,
 * lib/learning-loop/dashboard/loader.ts). THROWAWAY DATABASES ONLY: `seed`
 * writes a whole book, and the job and loader read without a tenant frame, so
 * the database must hold this one lender.
 *
 *   DATABASE_URL=postgresql://... npx tsx scripts/bench-learning-loop-reads.ts seed [loans]   # prints the tenant id
 *   DATABASE_URL=postgresql://... npx tsx scripts/bench-learning-loop-reads.ts run <tenant-id>
 *
 * The book: `loans` loans (default 2000) disbursed 420 days ago, each with 6
 * monthly instalments and a snapshot for each of the last 400 nights (the
 * worst case: every loan recorded every night). 10% stay open and 90+ DPD,
 * 10% settled after a 20-day arrears spell, the rest settled clean. `run`
 * prints, for the cold job run, the next night's run and the loader: SQL
 * statements, rows Prisma returned, wall time, and a digest of the result, so
 * two checkouts of the code can be compared on the same seeded book.
 */
import { createHash } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { loadDecisionPerformance, type DashboardDb } from "@/lib/learning-loop/dashboard/loader"
import { recordDecisions, type DecisionLogDb } from "@/lib/learning-loop/decision-log"
import { credaflowOutcomeAdapter, type CredaflowOutcomeDb } from "@/lib/learning-loop/outcomes/credaflow-adapter"
import { runTenantDecisionOutcomes, type OutcomeJobDb } from "@/lib/learning-loop/outcomes/job"
import { consumerApprovalRecords } from "@/lib/learning-loop/records"

const DAY = 86_400_000
const SNAPSHOT_DAYS = 400
const INSTALMENT_CENTS = 216_900
const base = new PrismaClient({ log: [{ emit: "event", level: "query" }] })
let statements = 0
let rows = 0
base.$on("query", () => { statements++ })

/** Rows in a result, nested relation rows included. */
function countRows(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, row) => n + 1 + countRows(row), 0)
  if (value === null || typeof value !== "object" || value instanceof Date) return 0
  return Object.values(value).reduce<number>((n, v) => n + (Array.isArray(v) ? countRows(v) : 0), 0)
}
const db = base.$extends({
  query: { $allModels: { async $allOperations({ args, query }) {
    const result = await query(args)
    rows += countRows(result)
    return result
  } } },
})

async function seed(loans: number) {
  const asOf = new Date()
  const asOfDay = asOf.toISOString().slice(0, 10)
  const tenant = await createChargesTenant(base, false)
  const t = tenant.tenantId
  const start = new Date(asOf.getTime() - 420 * DAY)
  const at = (n: number) => `${String(n).padStart(6, "0")}`
  const ids = Array.from({ length: loans }, (_, i) => ({ n: i, client: `bc_${t}_${at(i)}`, app: `ba_${t}_${at(i)}`, loan: `bl_${t}_${at(i)}` }))
  await base.client.createMany({ data: ids.map((x) => ({
    id: x.client, tenantId: t, idNumber: `9${at(x.n)}000000`, firstName: "Bench", lastName: "Test", email: `${x.client}@client.invalid`, phone: "0820000000",
  })) })
  await base.loanApplication.createMany({ data: ids.map((x) => ({
    id: x.app, tenantId: t, reference: `APP-${x.app}`, clientId: x.client, productId: tenant.productId, appliedAmount: 200_000, appliedTermDays: 180,
    disbursedAt: start,
  })) })
  const dueDate = (k: number) => new Date(start.getTime() + 30 * k * DAY)
  await base.loan.createMany({ data: ids.map((x) => ({
    id: x.loan, tenantId: t, reference: `BNCH-${t}-${x.n}`, applicationId: x.app, clientId: x.client, productId: tenant.productId,
    principal: 200_000, totalInterest: 10_000, initiationFee: 0, totalRepayable: INSTALMENT_CENTS * 6, outstandingPrincipal: 0,
    startDate: start, maturityDate: dueDate(6), interestRatePm: 0.05, interestModel: "FLAT" as const, monthlyServiceFee: 6_900,
    status: x.n % 10 === 0 ? "ACTIVE" as const : "COMPLETED" as const, closedAt: x.n % 10 === 0 ? null : dueDate(6),
  })) })
  await base.repaymentSchedule.createMany({ data: ids.flatMap((x) => Array.from({ length: 6 }, (_, i) => {
    const unpaid = x.n % 10 === 0 && i >= 2
    return {
      tenantId: t, loanId: x.loan, installmentNo: i + 1, dueDate: dueDate(i + 1), principalDue: 200_000 / 6, interestDue: 10_000 / 6, feesDue: 6_900,
      totalDue: INSTALMENT_CENTS, totalPaid: unpaid ? 0 : INSTALMENT_CENTS, status: unpaid ? "OVERDUE" as const : "PAID" as const,
      paidAt: unpaid ? null : dueDate(i + 1),
    }
  })) })
  // One snapshot per loan per night; the DPD of each loan is a function of its number (see the header).
  await base.$executeRaw`
    INSERT INTO "LoanArrearsSnapshot" ("id", "tenantId", "loanId", "snapshotDate", "status", "ncaRegime", "collectionsStage", "daysInArrears",
      "arrearsCents", "outstandingPrincipalCents", "chargesOutstandingCents", "chargesLive")
    SELECT gen_random_uuid()::text, "tenantId", loan_id, day, (CASE WHEN dpd >= 90 THEN 'DEFAULTED' ELSE 'ACTIVE' END)::"LoanStatus", 'NCA'::"NcaRegime",
      (CASE WHEN dpd = 0 THEN 'NONE' WHEN dpd < 15 THEN 'SOFT_REMINDER' WHEN dpd < 30 THEN 'FORMAL_REMINDER'
            WHEN dpd < 90 THEN 'SECTION_129_SENT' ELSE 'ATTORNEY_REFERRED' END)::"CollectionsStage",
      dpd, CASE WHEN dpd > 0 THEN ${INSTALMENT_CENTS} ELSE 0 END, 0, 0, false
    FROM (
      SELECT l."tenantId", l.id AS loan_id, d::date AS day, split_part(l.reference, '-', 3)::int AS n, l."startDate"::date AS start_day
      FROM "Loan" l, generate_series(${asOfDay}::date - ${SNAPSHOT_DAYS}::int, ${asOfDay}::date - 1, interval '1 day') d
      WHERE l."tenantId" = ${t}
    ) s,
    LATERAL (SELECT CASE
      WHEN n % 10 = 0 THEN GREATEST(0, day - (start_day + 90))
      WHEN n % 10 = 5 AND day >= start_day + 100 AND day < start_day + 120 THEN day - (start_day + 99)
      ELSE 0 END AS dpd) p`
  await base.arrearsSnapshotRun.createMany({ data: Array.from({ length: SNAPSHOT_DAYS }, (_, i) => ({
    tenantId: t, snapshotDate: new Date(Date.parse(`${asOfDay}T00:00:00Z`) - (i + 1) * DAY), loanCount: loans,
  })) })
  for (let i = 0; i < ids.length; i += 100) {
    await base.$transaction(async (tx) => {
      for (const x of ids.slice(i, i + 100)) {
        await recordDecisions(tx as unknown as DecisionLogDb, consumerApprovalRecords({
          tenantId: t, applicationId: x.app, clientId: x.client, actor: { userId: tenant.userId, role: "LOAN_ADMIN" },
          decidedAt: new Date(start.getTime() - 60_000),
          productType: "MICRO", interestRatePm: 0.05, principalCents: 200_000, termDays: 180, instalmentCents: INSTALMENT_CENTS,
          creditLifePremiumCents: 0, repaymentMethod: "DEBIT_ORDER", monthlyIncomeCents: 2_000_000,
          thresholds: { bureauMinScore: 580, bureauBlockAdverse: false, ndiBufferPct: 110, bureauMaxAgeDays: 60 },
          bureau: { id: "bureau-bench", provider: "experian", score: 640, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false, hasJudgement: false, hasNotice: false, obligations: { totalMonthly: 0 } },
          bureauGateBlocked: false, bureauOverrideReason: null,
          affordability: { ndiCents: 600_000, requiredNdiCents: 300_000 }, screeningState: "CLEAR", creditCheckFlags: [],
          affordabilitySnapshot: { policyVersion: "approval-ndi-v3", inputFingerprint: "a".repeat(64), decisionFingerprint: "b".repeat(64) },
        }))
      }
    }, { timeout: 120_000 })
  }
  process.stdout.write(`${t}\n`)
}

async function measure<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; line: Record<string, unknown> }> {
  statements = 0
  rows = 0
  const t0 = performance.now()
  const result = await fn()
  const ms = Math.round(performance.now() - t0)
  return { result, line: { step: label, statements, rowsReturned: rows, ms } }
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)

async function outcomesDigest(tenantId: string) {
  const all = await base.decisionOutcome.findMany({ where: { tenantId }, orderBy: [{ decisionRecordId: "asc" }, { outcomeKind: "asc" }, { window: "asc" }, { sourceRef: "asc" }] })
  return { rows: all.length, digest: digest(all.map(({ id: _id, computedAt: _c, ...r }) => r)) }
}

async function run(tenantId: string) {
  const asOf = new Date()
  const job = () => runTenantDecisionOutcomes(tenantId, asOf, [credaflowOutcomeAdapter(db as unknown as CredaflowOutcomeDb)], db as unknown as OutcomeJobDb)
  await base.decisionOutcome.deleteMany({ where: { tenantId } })
  const report: Array<Record<string, unknown>> = []
  const cold = await measure("job, first run (no outcome rows)", job)
  report.push({ ...cold.line, written: cold.result[0].written, skippedLoans: (cold.result[0] as { skippedLoans?: number }).skippedLoans ?? 0, ...await outcomesDigest(tenantId) })
  const next = await measure("job, next night (nothing changed)", job)
  report.push({ ...next.line, written: next.result[0].written, skippedLoans: (next.result[0] as { skippedLoans?: number }).skippedLoans ?? 0, ...await outcomesDigest(tenantId) })
  const load = () => loadDecisionPerformance(db as unknown as DashboardDb, tenantId, asOf, "12M")
  const page = await measure("dashboard loader (12M)", load)
  const { book: _book, ...figures } = { ...page.result, since: undefined }
  report.push({ ...page.line, approvals: page.result.approvals, stageEpisodes: page.result.stages.reduce((n, s) => n + s.episodes, 0), digest: digest(figures) })
  for (const line of report) process.stdout.write(`${JSON.stringify(line)}\n`)
}

async function main() {
  const [command, arg] = process.argv.slice(2)
  if (command === "seed") await seed(Number(arg ?? 2000))
  else if (command === "run" && arg) await run(arg)
  else throw new Error("usage: bench-learning-loop-reads.ts seed [loans] | run <tenant-id>")
}

main().finally(() => base.$disconnect())
