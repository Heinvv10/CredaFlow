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

const SNAPSHOT_SELECT = { loanId: true, eclCents: true, suspendedInterestCents: true, suspendedDefaultInterestCents: true } as const

export async function loadIfrs9Positions(
  db: Ifrs9AccountingDb,
  tenantId: string,
  period: AccountingPeriod,
  postedKeys: ReadonlySet<string>,
): Promise<Ifrs9Position[]> {
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
  const ids = [...listed.keys(), ...carried]
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
      journalsSuspense: journalsSuspense(loan.contractType),
      writtenOff,
      // Not in this run and not written off: it has left the book.
      closed: !writtenOff && (settled || !listed.has(loan.id)),
    }
  })
}

/** Why a period cannot close for want of its monthly run, or null (IFRS 9 off, not yet effective, or the run exists). */
export async function ifrs9RunRefusal(db: Ifrs9AccountingDb, tenantId: string, period: AccountingPeriod): Promise<string | null> {
  const settings = await loadSettings(db, tenantId)
  if (!settings.enabled) return null
  if (settings.effectiveFromMonth && period.key < settings.effectiveFromMonth) return null
  const run = await db.ifrs9Run.findFirst({ where: { tenantId, kind: "MONTHLY", periodKey: period.key, supersededBy: null }, select: { id: true } })
  return run ? null : `IFRS 9 is on and ${period.label} has no monthly staging run. It is made on the last day of the month; an administrator can add it for the ended month with POST /api/ifrs9/runs/monthly { periodKey: "${period.key}", reason }`
}
