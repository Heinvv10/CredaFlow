/**
 * Reads for the IFRS 9 sources (sources-ifrs9.ts): the latest MONTHLY run (the one no run supersedes) for a month up
 * to the period, and the loans the ledger already carries an IFRS 9 position for that this run no longer lists
 * (written off, settled).
 */
import type { prisma } from "@/lib/prisma"
import { journalsSuspense } from "@/lib/ifrs9/types"
import { loadSettings } from "@/lib/ifrs9/store"
import type { AccountingPeriod } from "./period"
import type { Ifrs9Position } from "./sources-ifrs9"

export type Ifrs9AccountingDb = Pick<typeof prisma, "ifrs9Run" | "ifrs9LoanSnapshot" | "ifrs9Config" | "loan">

const KEY = /^ifrs9:(?:ecl|suspense|netint):(.+)$/

/** Loan ids the ledger already holds an IFRS 9 position for. */
export function carriedLoanIds(postedKeys: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>()
  for (const key of postedKeys) {
    const match = KEY.exec(key)
    if (match) ids.add(match[1])
  }
  return ids
}

const SNAPSHOT_SELECT = { loanId: true, eclCents: true, suspendedInterestCents: true, suspendedDefaultInterestCents: true } as const

export async function loadIfrs9Positions(
  db: Ifrs9AccountingDb,
  tenantId: string,
  period: AccountingPeriod,
  postedKeys: ReadonlySet<string>,
): Promise<Ifrs9Position[]> {
  // A month IFRS 9 does not govern (off, or before its first month) posts nothing, whatever runs are on record.
  const settings = await loadSettings(db, tenantId)
  if (!settings.enabled || (settings.effectiveFromMonth !== null && period.key < settings.effectiveFromMonth)) return []
  const current = { tenantId, kind: "MONTHLY" as const, supersededBy: null, periodKey: { lte: period.key } }
  const run = await db.ifrs9Run.findFirst({ where: current, orderBy: { periodKey: "desc" }, select: { id: true, periodKey: true } })
  const inRun = run ? await db.ifrs9LoanSnapshot.findMany({ where: { tenantId, runId: run.id }, select: SNAPSHOT_SELECT }) : []
  const listed = new Map(inRun.map((r) => [r.loanId, r]))
  const carried = [...carriedLoanIds(postedKeys)].filter((id) => !listed.has(id))
  // For a carried loan the last snapshot says what was held before it left (a write-off uses that allowance and reduces the bad debt by the suspended interest).
  const last = carried.length === 0 ? [] : await db.ifrs9LoanSnapshot.findMany({
    where: { tenantId, loanId: { in: carried }, run: current },
    distinct: ["loanId"],
    orderBy: [{ loanId: "asc" }, { run: { periodKey: "desc" } }],
    select: { ...SNAPSHOT_SELECT, run: { select: { periodKey: true } } },
  })
  const lastById = new Map(last.map((r) => [r.loanId, r]))
  // Net basis: each Stage 3 month's adjustment summed over the current runs up to the period (none is given back).
  // Only months IFRS 9 governs count, and only rows that adjusted something.
  const governed = { ...current, ...(settings.effectiveFromMonth !== null ? { periodKey: { gte: settings.effectiveFromMonth, lte: period.key } } : {}) }
  const netSums = await db.ifrs9LoanSnapshot.groupBy({
    by: ["loanId"], where: { tenantId, run: governed, OR: [{ netInterestAdjustmentCents: { gt: 0 } }, { netDefaultInterestAdjustmentCents: { gt: 0 } }] },
    _sum: { netInterestAdjustmentCents: true, netDefaultInterestAdjustmentCents: true },
  })
  const netById = new Map(netSums.map((r) => [r.loanId, r._sum]))
  const ids = [...new Set([...listed.keys(), ...carried, ...netById.keys()])]
  if (ids.length === 0 || !run) return []
  const loans = await db.loan.findMany({
    where: { tenantId, id: { in: ids } },
    orderBy: { id: "asc" },
    select: { id: true, reference: true, contractType: true, status: true, writeOffAt: true, closedAt: true },
  })
  return loans.map((loan) => {
    const writtenOff = loan.status === "WRITTEN_OFF" && loan.writeOffAt !== null && loan.writeOffAt.getTime() < period.end.getTime()
    const settled = (loan.status === "COMPLETED" || loan.status === "CANCELLED") && loan.closedAt !== null && loan.closedAt.getTime() < period.end.getTime()
    const snapshot = listed.get(loan.id) ?? lastById.get(loan.id)
    return {
      loanId: loan.id, reference: loan.reference, periodKey: run.periodKey ?? period.key,
      eclCents: snapshot?.eclCents ?? 0,
      suspendedInterestCents: snapshot?.suspendedInterestCents ?? 0,
      suspendedDefaultInterestCents: snapshot?.suspendedDefaultInterestCents ?? 0,
      netInterestAdjustmentCents: netById.get(loan.id)?.netInterestAdjustmentCents ?? 0,
      netDefaultInterestAdjustmentCents: netById.get(loan.id)?.netDefaultInterestAdjustmentCents ?? 0,
      journalsSuspense: journalsSuspense(loan.contractType),
      exitUndated: (loan.status === "WRITTEN_OFF" && loan.writeOffAt === null) || ((loan.status === "COMPLETED" || loan.status === "CANCELLED") && loan.closedAt === null),
      writtenOff,
      // Left the book only by an exit dated before the period ended; one the run does not list for any other reason keeps its last position.
      closed: !writtenOff && settled,
    }
  })
}

export interface RunRefusal {
  code: "IFRS9_RUN_MISSING" | "IFRS9_RUN_STALE"
  message: string
}

/**
 * Why a period cannot close for want of its monthly run, or null (IFRS 9 off, not yet effective, or the run is there
 * and current). A run is stale when a run of an earlier month was made or replaced after it: each month's stages start
 * from the month before, so the later run no longer follows from it.
 */
export async function ifrs9RunRefusal(db: Ifrs9AccountingDb, tenantId: string, period: AccountingPeriod): Promise<RunRefusal | null> {
  const settings = await loadSettings(db, tenantId)
  if (!settings.enabled) return null
  if (settings.effectiveFromMonth && period.key < settings.effectiveFromMonth) return null
  const run = await db.ifrs9Run.findFirst({ where: { tenantId, kind: "MONTHLY", periodKey: period.key, supersededBy: null }, select: { id: true, createdAt: true, settings: true } })
  if (!run) {
    return {
      code: "IFRS9_RUN_MISSING",
      message: `IFRS 9 is on and ${period.label} has no monthly staging run. It is made on the last day of the month; an administrator can add it for the ended month with POST /api/ifrs9/runs/monthly { periodKey: "${period.key}", reason }`,
    }
  }
  // A run is made under the Stage 3 interest basis in force then; one made under the other basis is not what the lender now reports.
  const madeUnder = (run.settings as { stage3InterestBasis?: string } | null)?.stage3InterestBasis
  if (madeUnder !== undefined && madeUnder !== settings.stage3InterestBasis) {
    return {
      code: "IFRS9_RUN_STALE",
      message: `The ${period.label} IFRS 9 run was made on the ${madeUnder} basis and the lender's Stage 3 interest basis is now ${settings.stage3InterestBasis}: replace it with POST /api/ifrs9/runs/monthly { periodKey: "${period.key}", supersedesRunId: "${run.id}", reason }`,
    }
  }
  const newer = await db.ifrs9Run.findFirst({
    where: { tenantId, kind: "MONTHLY", supersededBy: null, periodKey: { lt: period.key }, createdAt: { gt: run.createdAt } },
    orderBy: { periodKey: "asc" }, select: { periodKey: true },
  })
  if (!newer) return null
  return {
    code: "IFRS9_RUN_STALE",
    message: `The ${period.label} IFRS 9 run was made before the ${newer.periodKey} run was made or replaced, so its stages no longer follow from it: replace it with POST /api/ifrs9/runs/monthly { periodKey: "${period.key}", supersedesRunId: "${run.id}", reason }`,
  }
}
