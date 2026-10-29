/** Reads the stored runs for the staging summary, the transition matrix and the loan-level export. */
import type { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { summariseStages, transitionMatrix, type ReportRow, type StageSummary, type TransitionMatrix } from "./report"
import type { Stage } from "./types"

type Db = Pick<typeof prisma, "ifrs9Run" | "ifrs9LoanSnapshot">

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

const head = (r: {
  id: string; kind: "MONTHLY" | "ON_DEMAND"; runDate: Date; periodKey: string | null; loanCount: number; totalEadCents: bigint; totalEclCents: bigint
  createdAt: Date; late: boolean; supersedesRunId: string | null; reason: string | null; supersededBy: { id: string } | null
}): RunHead => ({
  id: r.id, kind: r.kind, runDate: sastCalendarDate(r.runDate), periodKey: r.periodKey, loanCount: r.loanCount,
  totalEadCents: Number(r.totalEadCents), totalEclCents: Number(r.totalEclCents), createdAt: r.createdAt.toISOString(),
  late: r.late, superseded: r.supersededBy !== null, supersedesRunId: r.supersedesRunId, reason: r.reason,
})

export async function listRuns(db: Pick<Db, "ifrs9Run">, tenantId: string, limit = 24): Promise<RunHead[]> {
  const runs = await db.ifrs9Run.findMany({
    where: { tenantId }, orderBy: [{ runDate: "desc" }, { createdAt: "desc" }], take: limit, include: { supersededBy: { select: { id: true } } },
  })
  return runs.map(head)
}

async function rowsOf(db: Pick<Db, "ifrs9LoanSnapshot">, tenantId: string, runId: string): Promise<ReportRow[]> {
  const rows = await db.ifrs9LoanSnapshot.findMany({
    where: { tenantId, runId },
    select: { loanId: true, stage: true, eadCents: true, eclCents: true, suspendedInterestCents: true, suspendedDefaultInterestCents: true },
  })
  return rows.map((r) => ({
    loanId: r.loanId, stage: r.stage as Stage, eadCents: r.eadCents, eclCents: r.eclCents,
    suspendedCents: r.suspendedInterestCents + r.suspendedDefaultInterestCents,
  }))
}

/** `runId` defaults to the latest run nothing supersedes, `compareToRunId` to the one before it. Null when there is no such run. */
export async function loadRunReport(db: Db, tenantId: string, runId?: string, compareToRunId?: string): Promise<RunReport | null> {
  const runs = await listRuns(db, tenantId, 200)
  const live = runs.filter((r) => !r.superseded)
  const current = runId ? runs.find((r) => r.id === runId) : live[0]
  if (!current) return null
  const previous = compareToRunId
    ? runs.find((r) => r.id === compareToRunId) ?? null
    : runs.slice(runs.findIndex((r) => r.id === current.id) + 1).find((r) => !r.superseded) ?? null
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
    eadCents: r.eadCents, parameterScope: r.parameterScope, pdBps: r.pdBps, lgdBps: r.lgdBps, eclCents: r.eclCents,
  }))
}
