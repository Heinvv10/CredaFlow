/**
 * What closing a period would post, and whether it may close: the shared read
 * behind the preview and closePeriod (lib/accounting/generate.ts).
 *
 * A period may close only when it has ended, the lender has confirmed the
 * account mapping, it is the next month in order (the go-live month first),
 * and the journal's loan book ties to the independently computed receivable
 * for every loan (lib/accounting/reconcile.ts).
 */
import type { prisma } from "@/lib/prisma"
import { deriveEntries, type DerivedEntry } from "./derive"
import { openingEntry, openingPositions, positionsAsLedger, type OpeningPosition } from "./opening"
import { nextPeriodKey, parsePeriodKey, periodHasEnded, type AccountingPeriod } from "./period"
import { compareBooks, independentBook, journalBook, type Reconciliation } from "./reconcile"
import { loadAccountMap, loadLedger, loadSettings, loadSourceLoans, type AccountingDb } from "./store"
import { verifyBalanced, type BatchTotals } from "./verify"

export type CloseRefusal =
  | "INVALID_PERIOD"
  | "PERIOD_NOT_ENDED"
  | "OUT_OF_ORDER"
  | "MAPPING_NOT_CONFIRMED"
  | "GO_LIVE_NOT_SET"
  | "RECONCILIATION_FAILED"

export class AccountingPeriodError extends Error {
  constructor(readonly code: CloseRefusal, message: string) {
    super(message)
    this.name = "AccountingPeriodError"
  }
}

export function requirePeriod(periodKey: unknown): AccountingPeriod {
  const period = parsePeriodKey(periodKey)
  if (!period) throw new AccountingPeriodError("INVALID_PERIOD", "Period must be a month, yyyy-mm")
  return period
}

export type PlanDb = AccountingDb & Pick<typeof prisma, "$queryRaw">

export interface PeriodPlan {
  period: AccountingPeriod
  /** True for the go-live month's first close: entries start with the opening entry. */
  isGoLive: boolean
  entries: DerivedEntry[]
  positions: OpeningPosition[]
  totals: BatchTotals
  reconciliation: Reconciliation
  /** Why this period may not close now, or null. */
  refusal: { code: CloseRefusal; message: string } | null
}

async function orderRefusal(db: PlanDb, tenantId: string, period: AccountingPeriod, goLiveMonth: string | null): Promise<PeriodPlan["refusal"]> {
  const latest = await db.accountingExportBatch.findFirst({ where: { tenantId }, orderBy: { periodStart: "desc" }, select: { periodKey: true } })
  if (latest) {
    const next = nextPeriodKey(latest.periodKey)
    return next === period.key ? null : { code: "OUT_OF_ORDER", message: `The next month to close is ${next}` }
  }
  if (!goLiveMonth) return { code: "GO_LIVE_NOT_SET", message: "Set the go-live month first: earlier history posts as one opening entry" }
  return goLiveMonth === period.key ? null : { code: "OUT_OF_ORDER", message: `The first month to close is the go-live month, ${goLiveMonth}` }
}

export async function planPeriod(db: PlanDb, tenantId: string, period: AccountingPeriod, now = new Date()): Promise<PeriodPlan> {
  const [accounts, settings, loans, ledger, batchCount] = await Promise.all([
    loadAccountMap(db, tenantId),
    loadSettings(db, tenantId),
    loadSourceLoans(db, tenantId, period.end),
    loadLedger(db, tenantId),
    db.accountingExportBatch.count({ where: { tenantId } }),
  ])
  const isGoLive = batchCount === 0 && settings.goLiveMonth === period.key
  const positions = isGoLive ? openingPositions(loans, period) : []
  const base = isGoLive ? positionsAsLedger(positions) : ledger
  const vat = { registered: settings.vatRegistered, rateBps: settings.vatRateBps }
  const own = deriveEntries({ loans, period, accounts, vat, ...base })
  const opening = isGoLive ? openingEntry(positions, period, accounts) : null
  const entries = opening ? [opening, ...own] : own
  const totals = verifyBalanced(entries)
  const reconciliation = compareBooks(journalBook(base.posted, base.postedLoans, own), await independentBook(db, tenantId, period.end))

  let refusal: PeriodPlan["refusal"] = null
  if (!periodHasEnded(period, now)) refusal = { code: "PERIOD_NOT_ENDED", message: `${period.label} has not ended; a month closes once it is over` }
  else if (!settings.mappingConfirmedAt) refusal = { code: "MAPPING_NOT_CONFIRMED", message: "Review and confirm the chart-of-accounts mapping first" }
  else refusal = await orderRefusal(db, tenantId, period, settings.goLiveMonth)
  if (!refusal && reconciliation.mismatches.length > 0) {
    const sample = reconciliation.mismatches.slice(0, 3).map((m) => `${m.reference} (journal ${m.journalCents}, owed ${m.bookCents})`).join("; ")
    refusal = { code: "RECONCILIATION_FAILED", message: `The journal loan book does not tie to what borrowers owe for ${reconciliation.mismatches.length} loan(s): ${sample}` }
  }
  return { period, isGoLive, entries, positions, totals, reconciliation, refusal }
}
