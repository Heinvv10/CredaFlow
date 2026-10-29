/**
 * Reads for the IFRS 9 sources (sources-ifrs9.ts): the latest MONTHLY run on or
 * before a period, and the loans the ledger already carries an IFRS 9 position
 * for that this run no longer lists (written off, settled).
 */
import type { prisma } from "@/lib/prisma"
import { loadSettings } from "@/lib/ifrs9/store"
import type { AccountingPeriod } from "./period"
import type { Ifrs9Position } from "./sources-ifrs9"

export type Ifrs9AccountingDb = Pick<typeof prisma, "ifrs9Run" | "ifrs9LoanSnapshot" | "ifrs9Config" | "loan">

const KEY = /^ifrs9:(?:ecl|suspense):(.+)$/

/** Loan ids the ledger already holds an IFRS 9 position for. */
export function carriedLoanIds(postedKeys: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>()
  for (const key of postedKeys) {
    const match = KEY.exec(key)
    if (match) ids.add(match[1])
  }
  return ids
}

const sastMidnight = (date: Date): Date => new Date(date.toISOString().slice(0, 10) + "T00:00:00+02:00")

export async function loadIfrs9Positions(
  db: Ifrs9AccountingDb,
  tenantId: string,
  period: AccountingPeriod,
  postedKeys: ReadonlySet<string>,
): Promise<Ifrs9Position[]> {
  const run = await db.ifrs9Run.findFirst({
    where: { tenantId, kind: "MONTHLY", periodKey: { lte: period.key } },
    orderBy: { periodKey: "desc" },
    select: { id: true, runDate: true },
  })
  const select = { loanId: true, contractType: true, eclCents: true, suspendedInterestCents: true, suspendedDefaultInterestCents: true } as const
  const inRun = run ? await db.ifrs9LoanSnapshot.findMany({ where: { tenantId, runId: run.id }, select }) : []
  const listed = new Set(inRun.map((r) => r.loanId))
  const carried = [...carriedLoanIds(postedKeys)].filter((id) => !listed.has(id))
  // For a carried loan the last snapshot says what was suspended before it left (a write-off turns that into a reduction of the bad debt).
  const last = carried.length === 0 ? [] : await db.ifrs9LoanSnapshot.findMany({
    where: { tenantId, loanId: { in: carried }, run: { kind: "MONTHLY", periodKey: { lte: period.key } } },
    distinct: ["loanId"],
    orderBy: [{ loanId: "asc" }, { run: { periodKey: "desc" } }],
    select,
  })
  const lastById = new Map(last.map((r) => [r.loanId, r]))
  const ids = [...listed, ...carried]
  if (ids.length === 0) return []
  const loans = await db.loan.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, reference: true, status: true, writeOffAt: true, closedAt: true },
  })
  const runDate = run ? sastMidnight(run.runDate) : period.start
  const positions: Ifrs9Position[] = []
  for (const loan of loans) {
    const writtenOff = loan.status === "WRITTEN_OFF" && loan.writeOffAt !== null && loan.writeOffAt.getTime() < period.end.getTime()
    const settled = (loan.status === "COMPLETED" || loan.status === "CANCELLED") && loan.closedAt !== null && loan.closedAt.getTime() < period.end.getTime()
    const snapshot = inRun.find((r) => r.loanId === loan.id) ?? lastById.get(loan.id)
    // Not in this run and not written off: it has left the book.
    const closed = !writtenOff && (settled || !listed.has(loan.id))
    positions.push({
      loanId: loan.id, reference: loan.reference, runDate,
      eclCents: snapshot?.eclCents ?? 0,
      suspendedInterestCents: snapshot?.suspendedInterestCents ?? 0,
      suspendedDefaultInterestCents: snapshot?.suspendedDefaultInterestCents ?? 0,
      journalsSuspense: (snapshot?.contractType ?? "LOAN") === "LOAN",
      writtenOff, closed,
    })
  }
  return positions.sort((a, b) => (a.loanId < b.loanId ? -1 : 1))
}

/** Why a period cannot close for want of its monthly run, or null (IFRS 9 off, not yet effective, or the run exists). */
export async function ifrs9RunRefusal(db: Ifrs9AccountingDb, tenantId: string, period: AccountingPeriod): Promise<string | null> {
  const settings = await loadSettings(db, tenantId)
  if (!settings.enabled) return null
  if (settings.effectiveFromMonth && period.key < settings.effectiveFromMonth) return null
  const run = await db.ifrs9Run.findFirst({ where: { tenantId, kind: "MONTHLY", periodKey: period.key }, select: { id: true } })
  return run ? null : `IFRS 9 is on and ${period.label} has no monthly staging run: run it before closing the month (Reports, IFRS 9)`
}
