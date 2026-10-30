/** Reads the stored runs for the staging summary, the transition matrix and the loan-level export. */
import type { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { summariseStages, transitionMatrix, type ReportRow, type StageSummary, type TransitionMatrix } from "./report"
import { loadSettings } from "./store"
import type { Ifrs9Settings, Stage } from "./types"

type Db = Pick<typeof prisma, "ifrs9Run" | "ifrs9LoanSnapshot" | "ifrs9Config">
type Basis = Ifrs9Settings["stage3InterestBasis"]

export interface RunHead {
  id: string
  kind: "MONTHLY" | "ON_DEMAND"
  runDate: string
  periodKey: string | null
  loanCount: number
  totalEadCents: number
  totalEclCents: number
  createdAt: string
  /** Made after its month ended. */
  late: boolean
  /** A newer run replaces this one (it is kept on record, and no report defaults to it). */
  superseded: boolean
  /**
   * A MONTHLY run that its month's close refuses until it is replaced: made before an earlier month's current run was
   * made or replaced, or made on another Stage 3 interest basis than the lender's now.
   */
  stale: boolean
  /** The Stage 3 interest basis the run was made on. */
  basis: Basis
  supersedesRunId: string | null
  reason: string | null
}

export interface RunReport {
  run: RunHead
  /** The run it is compared with: the one before it unless one was named. */
  previousRun: RunHead | null
  summary: StageSummary
  transitions: TransitionMatrix | null
}

const RUN_INCLUDE = { supersededBy: { select: { id: true } } } as const

const head = (r: {
  id: string; kind: "MONTHLY" | "ON_DEMAND"; runDate: Date; periodKey: string | null; loanCount: number; totalEadCents: bigint; totalEclCents: bigint
  createdAt: Date; late: boolean; supersedesRunId: string | null; reason: string | null; settings: unknown; supersededBy: { id: string } | null
}): RunHead => ({
  id: r.id, kind: r.kind, runDate: sastCalendarDate(r.runDate), periodKey: r.periodKey, loanCount: r.loanCount,
  totalEadCents: Number(r.totalEadCents), totalEclCents: Number(r.totalEclCents), createdAt: r.createdAt.toISOString(),
  late: r.late, superseded: r.supersededBy !== null, stale: false, supersedesRunId: r.supersedesRunId, reason: r.reason,
  basis: (r.settings as { stage3InterestBasis?: Basis } | null)?.stage3InterestBasis ?? "FULL_SUSPENSION",
})

/**
 * Every MONTHLY run nothing supersedes, latest month first, with the stale flag set. Not capped: the month-end runs are
 * the ledger's and a report or action that looks at a window of all runs would miss them behind a burst of analysis runs.
 */
export async function loadOfficialMonthly(db: Pick<Db, "ifrs9Run">, tenantId: string, currentBasis?: Basis): Promise<RunHead[]> {
  const runs = await db.ifrs9Run.findMany({
    where: { tenantId, kind: "MONTHLY", supersededBy: null }, orderBy: [{ periodKey: "desc" }, { createdAt: "desc" }], include: RUN_INCLUDE,
  })
  const heads = runs.map(head)
  for (const run of heads) {
    const chain = heads.some((other) => other.periodKey! < run.periodKey! && other.createdAt > run.createdAt)
    run.stale = chain || (currentBasis !== undefined && run.basis !== currentBasis)
  }
  return heads
}

/** The recent runs of every kind, latest first (for display); a month-end run's stale flag comes from the whole chain. */
export async function listRuns(db: Db, tenantId: string, limit = 24): Promise<RunHead[]> {
  const [runs, settings] = await Promise.all([
    db.ifrs9Run.findMany({ where: { tenantId }, orderBy: [{ runDate: "desc" }, { createdAt: "desc" }], take: limit, include: RUN_INCLUDE }),
    loadSettings(db, tenantId),
  ])
  const stale = new Set((await loadOfficialMonthly(db, tenantId, settings.stage3InterestBasis)).filter((r) => r.stale).map((r) => r.id))
  return runs.map(head).map((r) => ({ ...r, stale: stale.has(r.id) }))
}

async function rowsOf(db: Pick<Db, "ifrs9LoanSnapshot">, tenantId: string, runId: string): Promise<ReportRow[]> {
  const rows = await db.ifrs9LoanSnapshot.findMany({
    where: { tenantId, runId },
    select: {
      loanId: true, stage: true, eadCents: true, eclCents: true, suspendedInterestCents: true, suspendedDefaultInterestCents: true,
      netInterestAdjustmentCents: true, netDefaultInterestAdjustmentCents: true,
    },
  })
  return rows.map((r) => ({
    loanId: r.loanId, stage: r.stage as Stage, eadCents: r.eadCents, eclCents: r.eclCents,
    suspendedCents: r.suspendedInterestCents + r.suspendedDefaultInterestCents,
    netAdjustmentCents: r.netInterestAdjustmentCents + r.netDefaultInterestAdjustmentCents,
  }))
}

async function findRun(db: Pick<Db, "ifrs9Run">, tenantId: string, id: string, official: readonly RunHead[]): Promise<RunHead | null> {
  const known = official.find((r) => r.id === id)
  if (known) return known
  const row = await db.ifrs9Run.findFirst({ where: { tenantId, id }, include: RUN_INCLUDE })
  return row ? head(row) : null
}

/**
 * `runId` defaults to the latest month-end run nothing supersedes (never an analysis run), `compareToRunId` to the
 * month-end run before it (for an analysis run: the latest month-end run). Runs are looked up by id, wherever they sit
 * in the history. Null when there is no such run.
 */
export async function loadRunReport(db: Db, tenantId: string, runId?: string, compareToRunId?: string): Promise<RunReport | null> {
  const official = await loadOfficialMonthly(db, tenantId, (await loadSettings(db, tenantId)).stage3InterestBasis)
  const current = runId ? await findRun(db, tenantId, runId, official) : official[0] ?? null
  if (!current) return null
  const previous = compareToRunId
    ? await findRun(db, tenantId, compareToRunId, official)
    : current.kind === "MONTHLY"
      ? official.find((r) => r.id !== current.id && r.periodKey! < current.periodKey!) ?? null
      : official[0] ?? null
  const rows = await rowsOf(db, tenantId, current.id)
  return {
    run: current, previousRun: previous, summary: summariseStages(rows),
    transitions: previous ? transitionMatrix(await rowsOf(db, tenantId, previous.id), rows) : null,
  }
}

export interface LoanEclRow {
  reference: string
  product: string
  contractType: string
  loanStatus: string
  daysPastDue: number
  stage: Stage
  previousStage: Stage | null
  reasons: string[]
  stageSince: string
  outstandingPrincipalCents: number
  unpaidInterestCents: number
  unpaidFeesCents: number
  chargesOutstandingCents: number
  accruedInterestCents: number
  suspendedInterestCents: number
  suspendedDefaultInterestCents: number
  netInterestAdjustmentCents: number
  netDefaultInterestAdjustmentCents: number
  eadCents: number
  parameterScope: string
  pdBps: number
  lgdBps: number
  eclCents: number
}

export async function loadLoanLevel(db: Pick<Db, "ifrs9LoanSnapshot">, tenantId: string, runId: string): Promise<LoanEclRow[]> {
  const rows = await db.ifrs9LoanSnapshot.findMany({
    where: { tenantId, runId },
    include: { loan: { select: { reference: true, product: { select: { name: true } } } } },
    orderBy: { loan: { reference: "asc" } },
  })
  return rows.map((r) => ({
    reference: r.loan.reference, product: r.loan.product.name, contractType: r.contractType, loanStatus: r.loanStatus, daysPastDue: r.daysPastDue,
    stage: r.stage as Stage, previousStage: r.previousStage as Stage | null, reasons: r.reasons, stageSince: sastCalendarDate(r.stageSince),
    outstandingPrincipalCents: r.outstandingPrincipalCents, unpaidInterestCents: r.unpaidInterestCents, unpaidFeesCents: r.unpaidFeesCents,
    chargesOutstandingCents: r.chargesOutstandingCents, accruedInterestCents: r.accruedInterestCents,
    suspendedInterestCents: r.suspendedInterestCents, suspendedDefaultInterestCents: r.suspendedDefaultInterestCents,
    netInterestAdjustmentCents: r.netInterestAdjustmentCents, netDefaultInterestAdjustmentCents: r.netDefaultInterestAdjustmentCents,
    eadCents: r.eadCents, parameterScope: r.parameterScope, pdBps: r.pdBps, lgdBps: r.lgdBps, eclCents: r.eclCents,
  }))
}
