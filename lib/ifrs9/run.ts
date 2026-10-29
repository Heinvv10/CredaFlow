/**
 * A staging run: every loan of the collectible book gets its stage, exposure,
 * interest in suspense and ECL as at today (SAST), stored as one immutable
 * Ifrs9Run with its Ifrs9LoanSnapshot rows. The policy and the PD/LGD rows
 * used are copied into the run. MONTHLY runs (one per month, the cron's, read
 * by the accounting close) and ON_DEMAND runs (analysis only) share this path.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { loadLoanCharges } from "@/lib/loan/charges-summary"
import { loadPriorStaging, loadRunLoans } from "./loan-input"
import { missingDefaults } from "./parameters"
import { resolveMonthlyPeriod } from "./period"
import { assessLoan, buildSnapshot, type RunContext, type SnapshotData } from "./snapshot"
import { loadParameters, loadSettings } from "./store"
import type { Stage } from "./types"

export type RunRefusal = "PARAMETERS_MISSING" | "NOT_ENABLED" | "INVALID_PERIOD"

export class Ifrs9RunError extends Error {
  constructor(readonly code: RunRefusal, message: string) {
    super(message)
    this.name = "Ifrs9RunError"
  }
}

export interface RunOptions {
  kind: "MONTHLY" | "ON_DEMAND"
  /** MONTHLY only: see resolveMonthlyPeriod. */
  periodKey?: string
  now?: Date
  actor?: { id: string; email: string }
}

export interface RunSummary {
  runId: string
  /** False when the month already had its MONTHLY run (nothing was written). */
  created: boolean
  kind: "MONTHLY" | "ON_DEMAND"
  runDate: string
  periodKey: string | null
  loanCount: number
  totalEadCents: number
  totalEclCents: number
}

/** A large book is one transaction; Prisma's 5 s interactive default is too short. */
const TX_TIMEOUT_MS = 120_000
const CHUNK = 500
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

async function existingMonthly(tenantId: string, periodKey: string): Promise<RunSummary | null> {
  const run = await prisma.ifrs9Run.findUnique({ where: { tenantId_periodKey: { tenantId, periodKey } } })
  if (!run) return null
  return {
    runId: run.id, created: false, kind: "MONTHLY", runDate: sastCalendarDate(run.runDate), periodKey,
    loanCount: run.loanCount, totalEadCents: Number(run.totalEadCents), totalEclCents: Number(run.totalEclCents),
  }
}

export async function executeRun(tenantId: string, options: RunOptions): Promise<RunSummary> {
  const now = options.now ?? new Date()
  const runDate = sastCalendarDate(now)
  const settings = await loadSettings(prisma, tenantId)
  let periodKey: string | null = null
  if (options.kind === "MONTHLY") {
    if (!settings.enabled) throw new Ifrs9RunError("NOT_ENABLED", "IFRS 9 is not enabled for this lender")
    const period = resolveMonthlyPeriod(runDate, options.periodKey)
    if (!period.ok) throw new Ifrs9RunError("INVALID_PERIOD", period.error)
    periodKey = period.periodKey
    const existing = await existingMonthly(tenantId, periodKey)
    if (existing) return existing
  }
  const parameters = await loadParameters(prisma, tenantId)
  const missing = missingDefaults(parameters)
  if (missing.length > 0) {
    throw new Ifrs9RunError("PARAMETERS_MISSING", `Set the lender default PD and LGD for stage ${missing.join(", ")} before running`)
  }

  const ctx: RunContext = { settings, parameters, runAt: now, chargesLive: await chargesLiveForTenant(prisma, tenantId) }
  const [loans, priors] = await Promise.all([loadRunLoans(prisma, tenantId), loadPriorStaging(prisma, tenantId)])
  const rows: SnapshotData[] = []
  for (const loan of loans) {
    const assessment = assessLoan(loan, ctx, priors.get(loan.id) ?? null)
    // Default interest is replayed only for a loan whose interest is suspended and which owes charges.
    const defaultInterest = assessment.suspended && ctx.chargesLive && loan.chargesOutstanding > 0
      ? (await loadLoanCharges(prisma, { tenantId, loanId: loan.id }, now))?.buckets.DEFAULT_INTEREST.outstanding ?? 0
      : 0
    rows.push(buildSnapshot(loan, ctx, assessment, defaultInterest))
  }
  const totalEad = rows.reduce((sum, r) => sum + r.eadCents, 0)
  const totalEcl = rows.reduce((sum, r) => sum + r.eclCents, 0)

  try {
    const runId = await prisma.$transaction(async (tx) => {
      const run = await tx.ifrs9Run.create({
        data: {
          tenantId, kind: options.kind, runDate: day(runDate), periodKey, loanCount: rows.length,
          settings: { ...settings }, parameters: parameters.map((p) => ({ ...p })),
          totalEadCents: BigInt(totalEad), totalEclCents: BigInt(totalEcl), startedById: options.actor?.id ?? null,
        },
      })
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.ifrs9LoanSnapshot.createMany({
          data: rows.slice(i, i + CHUNK).map((r) => ({
            ...r, tenantId, runId: run.id, runDate: day(r.runDate), stageSince: day(r.stageSince),
            cureStartedOn: r.cureStartedOn ? day(r.cureStartedOn) : null,
          })),
        })
      }
      await logAuditStrict({
        tenantId, userId: options.actor?.id, userEmail: options.actor?.email, action: AuditAction.IFRS9_RUN_CREATED,
        entity: "Ifrs9Run", entityId: run.id,
        newValue: { kind: options.kind, runDate, periodKey, loanCount: rows.length, totalEadCents: totalEad, totalEclCents: totalEcl, stages: stageCounts(rows) },
      }, tx)
      return run.id
    }, { timeout: TX_TIMEOUT_MS })
    return { runId, created: true, kind: options.kind, runDate, periodKey, loanCount: rows.length, totalEadCents: totalEad, totalEclCents: totalEcl }
  } catch (error) {
    // A concurrent replica won the month's unique run: it is the run.
    if (periodKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await existingMonthly(tenantId, periodKey)
      if (existing) return existing
    }
    throw error
  }
}

function stageCounts(rows: readonly SnapshotData[]): Record<Stage, number> {
  const counts: Record<Stage, number> = { 1: 0, 2: 0, 3: 0 }
  for (const r of rows) counts[r.stage] += 1
  return counts
}
