/**
 * A staging run: every loan of the collectible book gets its stage, exposure,
 * interest in suspense and ECL, stored as one immutable Ifrs9Run with its
 * Ifrs9LoanSnapshot rows. The policy and the PD/LGD rows used are copied into
 * the run.
 *
 * ON_DEMAND runs describe today and are analysis only: nothing reads them
 * back into a later stage or the ledger. A MONTHLY run stands for one month and
 * is dated its last day, whenever it is made (a make-up, late or superseding
 * run is rebuilt as at that day, loan-input.ts): the cron makes it on the last
 * SAST day, an administrator can add a late one for an unclosed month or
 * supersede one (with a reason) until the month closes. The accounting close
 * reads the latest run nothing supersedes (lib/accounting/store-ifrs9.ts).
 */
import { Prisma } from "@prisma/client"
import { lockAccounting } from "@/lib/accounting/route-helpers"
import { parsePeriodKey } from "@/lib/accounting/period"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { loadLoanCharges } from "@/lib/loan/charges-summary"
import { loadDefaultInterestRaised, loadPriorStaging, loadRunLoans, priorRunFingerprint } from "./loan-input"
import { missingDefaults } from "./parameters"
import { monthlyInstants, periodEndDate, previousMonthKey } from "./period"
import { assessLoan, buildSnapshot, type RunContext, type SnapshotData } from "./snapshot"
import { loadParameters, loadSettings } from "./store"
import type { Stage } from "./types"

export type RunRefusal = "PARAMETERS_MISSING" | "NOT_ENABLED" | "INVALID_PERIOD" | "PERIOD_NOT_ENDED" | "PERIOD_CLOSED" | "SUPERSEDE_STALE" | "PREVIOUS_MONTH_MISSING" | "NOT_EFFECTIVE" | "CHAIN_CHANGED"

export class Ifrs9RunError extends Error {
  constructor(readonly code: RunRefusal, message: string) {
    super(message)
    this.name = "Ifrs9RunError"
  }
}

export type RunOptions = { now?: Date; actor?: { id: string; email: string } } & (
  | { kind: "ON_DEMAND" }
  | { kind: "MONTHLY"; periodKey: string; supersede?: { runId: string; reason: string }; lateReason?: string }
)

export interface RunSummary {
  runId: string
  /** False when the month already had its MONTHLY run (nothing was written). */
  created: boolean
  kind: "MONTHLY" | "ON_DEMAND"
  runDate: string
  periodKey: string | null
  late: boolean
  loanCount: number
  totalEadCents: number
  totalEclCents: number
}

/** A large book is one transaction; Prisma's 5 s interactive default is too short. */
const TX_TIMEOUT_MS = 120_000
const CHUNK = 500
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

type RunRow = { id: string; kind: "MONTHLY" | "ON_DEMAND"; runDate: Date; periodKey: string | null; late: boolean; loanCount: number; totalEadCents: bigint; totalEclCents: bigint }

const summaryOf = (run: RunRow, created: boolean): RunSummary => ({
  runId: run.id, created, kind: run.kind, runDate: sastCalendarDate(run.runDate), periodKey: run.periodKey, late: run.late,
  loanCount: run.loanCount, totalEadCents: Number(run.totalEadCents), totalEclCents: Number(run.totalEclCents),
})

/** The month's run no other run supersedes, or null. */
export async function currentMonthlyRun(db: Pick<typeof prisma, "ifrs9Run">, tenantId: string, periodKey: string) {
  return db.ifrs9Run.findFirst({ where: { tenantId, kind: "MONTHLY", periodKey, supersededBy: null } })
}

async function periodClosed(tenantId: string, periodKey: string): Promise<boolean> {
  return (await prisma.accountingExportBatch.count({ where: { tenantId, periodKey } })) > 0
}

async function snapshotRows(tenantId: string, ctx: RunContext, asOf: Date | null, runDate: string): Promise<SnapshotData[]> {
  const [loans, priors] = await Promise.all([loadRunLoans(prisma, tenantId, ctx.runAt, asOf), loadPriorStaging(prisma, tenantId, runDate)])
  const net = ctx.settings.stage3InterestBasis === "NET_BASIS" && ctx.periodStart != null && ctx.chargesLive
  const raised = net ? await loadDefaultInterestRaised(prisma, tenantId, loans.map((l) => l.id), ctx.periodStart!, runDate) : new Map<string, number>()
  const rows: SnapshotData[] = []
  for (const loan of loans) {
    const assessment = assessLoan(loan, ctx, priors.get(loan.id) ?? null)
    // Default interest owed is replayed only for a Stage 3 loan on the full basis which owes charges.
    const owed = assessment.suspended && !net && ctx.chargesLive && loan.chargesOutstanding > 0
      ? (await loadLoanCharges(prisma, { tenantId, loanId: loan.id }, ctx.runAt))?.buckets.DEFAULT_INTEREST.outstanding ?? 0
      : 0
    rows.push(buildSnapshot(loan, ctx, assessment, owed, raised.get(loan.id) ?? 0))
  }
  return rows
}

/** A month's first run needs the month before it to have one, when that month is one IFRS 9 governs: each stage starts from the last. */
async function requirePreviousMonth(tenantId: string, periodKey: string, effectiveFromMonth: string | null): Promise<void> {
  const previous = previousMonthKey(periodKey)
  const governed = effectiveFromMonth !== null
    ? previous >= effectiveFromMonth
    : (await prisma.ifrs9Run.count({ where: { tenantId, kind: "MONTHLY", periodKey: { lte: previous } } })) > 0
  if (governed && !(await currentMonthlyRun(prisma, tenantId, previous))) {
    throw new Ifrs9RunError("PREVIOUS_MONTH_MISSING", `${previous} has no monthly run: make it first, because ${periodKey} starts from its stages`)
  }
}

export async function executeRun(tenantId: string, options: RunOptions): Promise<RunSummary> {
  const now = options.now ?? new Date()
  const today = sastCalendarDate(now)
  const settings = await loadSettings(prisma, tenantId)
  const monthly = options.kind === "MONTHLY" ? options : null
  const periodKey = monthly?.periodKey ?? null
  if (monthly) {
    if (!settings.enabled) throw new Ifrs9RunError("NOT_ENABLED", "IFRS 9 is not enabled for this lender")
    if (!parsePeriodKey(monthly.periodKey)) throw new Ifrs9RunError("INVALID_PERIOD", "periodKey must be a month, yyyy-mm")
    if (settings.effectiveFromMonth !== null && monthly.periodKey < settings.effectiveFromMonth) {
      throw new Ifrs9RunError("NOT_EFFECTIVE", `IFRS 9 takes effect from ${settings.effectiveFromMonth}: ${monthly.periodKey} is not a month it governs`)
    }
    if (periodEndDate(monthly.periodKey) > today) throw new Ifrs9RunError("PERIOD_NOT_ENDED", `${monthly.periodKey} has not reached its last day`)
    if (await periodClosed(tenantId, monthly.periodKey)) throw new Ifrs9RunError("PERIOD_CLOSED", `${monthly.periodKey} is closed: its run can no longer change`)
    const current = await currentMonthlyRun(prisma, tenantId, monthly.periodKey)
    if (current && !monthly.supersede) return summaryOf(current, false)
    if (!current) await requirePreviousMonth(tenantId, monthly.periodKey, settings.effectiveFromMonth)
    if (monthly.supersede && current?.id !== monthly.supersede.runId) {
      throw new Ifrs9RunError("SUPERSEDE_STALE", "That is not the month's current run: reload and try again")
    }
  }
  const parameters = await loadParameters(prisma, tenantId)
  const missing = missingDefaults(parameters)
  if (missing.length > 0) {
    throw new Ifrs9RunError("PARAMETERS_MISSING", `Set the lender default PD and LGD for stage ${missing.join(", ")} before running`)
  }

  const instants = periodKey ? monthlyInstants(periodKey, today) : null
  const runDate = instants?.runDate ?? today
  const backdated = instants?.receiptsBefore != null
  const ctx: RunContext = {
    settings, parameters, runAt: instants?.runAt ?? now, chargesLive: await chargesLiveForTenant(prisma, tenantId),
    periodStart: periodKey ? `${periodKey}-01` : null,
  }
  // The runs the prior stages come from, taken before they are read and checked again under the accounting lock.
  const priorRuns = monthly ? await priorRunFingerprint(prisma, tenantId, runDate) : null
  const rows = await snapshotRows(tenantId, ctx, instants?.receiptsBefore ?? null, runDate)
  const totalEad = rows.reduce((sum, r) => sum + r.eadCents, 0)
  const totalEcl = rows.reduce((sum, r) => sum + r.eclCents, 0)
  const late = monthly !== null && backdated
  const reason = monthly?.supersede?.reason ?? monthly?.lateReason ?? null

  try {
    const run = await prisma.$transaction(async (tx) => {
      // The close holds this lock for its whole transaction: a run is added before it reads, or the month is closed.
      if (monthly) {
        await lockAccounting(tx, tenantId)
        if (priorRuns !== await priorRunFingerprint(tx, tenantId, runDate)) {
          throw new Ifrs9RunError("CHAIN_CHANGED", "An earlier month's run was made or replaced while this one was being worked out: reload and try again")
        }
      }
      const created = await tx.ifrs9Run.create({
        data: {
          tenantId, kind: options.kind, runDate: day(runDate), periodKey, loanCount: rows.length, late,
          settings: { ...settings }, parameters: parameters.map((p) => ({ ...p })),
          totalEadCents: BigInt(totalEad), totalEclCents: BigInt(totalEcl), startedById: options.actor?.id ?? null,
          supersedesRunId: monthly?.supersede?.runId ?? null, reason,
        },
      })
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.ifrs9LoanSnapshot.createMany({
          data: rows.slice(i, i + CHUNK).map((r) => ({
            ...r, tenantId, runId: created.id, runDate: day(r.runDate), stageSince: day(r.stageSince),
            cureStartedOn: r.cureStartedOn ? day(r.cureStartedOn) : null,
          })),
        })
      }
      await logAuditStrict({
        tenantId, userId: options.actor?.id, userEmail: options.actor?.email, action: AuditAction.IFRS9_RUN_CREATED,
        entity: "Ifrs9Run", entityId: created.id,
        newValue: {
          kind: options.kind, runDate, periodKey, late, reason, supersedesRunId: monthly?.supersede?.runId ?? null,
          loanCount: rows.length, totalEadCents: totalEad, totalEclCents: totalEcl, stages: stageCounts(rows),
        },
      }, tx)
      return created
    }, { timeout: TX_TIMEOUT_MS })
    return summaryOf(run, true)
  } catch (error) {
    if (periodKey) {
      // A concurrent replica won the month's run, or the month closed while this one was being worked out.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // A concurrent supersede of the same run won: this request named a run that is no longer the month's.
        if (monthly?.supersede) throw new Ifrs9RunError("SUPERSEDE_STALE", "That is not the month's current run: reload and try again")
        const existing = await currentMonthlyRun(prisma, tenantId, periodKey)
        if (existing) return summaryOf(existing, false)
      }
      if (error instanceof Error && error.message.includes("accounting period of this IFRS 9 run is closed")) {
        throw new Ifrs9RunError("PERIOD_CLOSED", `${periodKey} closed while the run was being made`)
      }
    }
    throw error
  }
}

function stageCounts(rows: readonly SnapshotData[]): Record<Stage, number> {
  const counts: Record<Stage, number> = { 1: 0, 2: 0, 3: 0 }
  for (const r of rows) counts[r.stage] += 1
  return counts
}
