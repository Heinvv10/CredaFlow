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
import { assetFinanceControls, journalByKey, type ControlMismatch } from "./reconcile-controls"
import { loadAccountMap, loadLedger, loadSettings, loadSourceLoans, type AccountingDb } from "./store"
import { loadAssetFinanceLoans } from "./store-asset-finance"
import { ASSET_FINANCE_ROLES, IFRS9_ROLES } from "./accounts"
import { ifrs9Sources } from "./sources-ifrs9"
import { ifrs9RunRefusal, loadIfrs9Positions, type Ifrs9AccountingDb } from "./store-ifrs9"
import { verifyBalanced, type BatchTotals } from "./verify"

export type CloseRefusal =
  | "INVALID_PERIOD"
  | "PERIOD_NOT_ENDED"
  | "OUT_OF_ORDER"
  | "MAPPING_NOT_CONFIRMED"
  | "GO_LIVE_NOT_SET"
  | "RECONCILIATION_FAILED"
  | "AF_CONTROL_FAILED"
  | "AF_SOURCE_UNSUPPORTED"
  | "IFRS9_RUN_MISSING"
  | "IFRS9_RUN_STALE"
  | "CONCURRENT_CHANGE"

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

export type PlanDb = AccountingDb & Ifrs9AccountingDb & Pick<typeof prisma, "$queryRaw">

export interface PeriodPlan {
  period: AccountingPeriod
  /** True for the go-live month's first close: entries start with the opening entry. */
  isGoLive: boolean
  entries: DerivedEntry[]
  positions: OpeningPosition[]
  totals: BatchTotals
  reconciliation: Reconciliation
  /** Asset-finance controls that differ (empty when every one ties). */
  controls: ControlMismatch[]
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
  const [accounts, settings, consumerLoans, assetFinance, ledger, batchCount] = await Promise.all([
    loadAccountMap(db, tenantId),
    loadSettings(db, tenantId),
    loadSourceLoans(db, tenantId, period.end),
    loadAssetFinanceLoans(db, tenantId),
    loadLedger(db, tenantId),
    db.accountingExportBatch.count({ where: { tenantId } }),
  ])
  // A contract the sources cannot express yet is left out of the preview and refuses the close.
  // Only from the day it first matters: a contract that cannot be posted yet blocks the months it would post in, never earlier ones.
  const unsupported = assetFinance.unsupported.filter((u) => u.from === null || u.from.getTime() < period.end.getTime())
  const unsupportedIds = new Set(unsupported.map((u) => u.loanId))
  const loans = [...consumerLoans, ...assetFinance.loans.filter((l) => !unsupportedIds.has(l.id))]
  const isGoLive = batchCount === 0 && settings.goLiveMonth === period.key
  const positions = isGoLive ? openingPositions(loans, period) : []
  const base = isGoLive ? positionsAsLedger(positions) : ledger
  const vat = { registered: settings.vatRegistered, rateBps: settings.vatRateBps }
  const extraSources = ifrs9Sources(await loadIfrs9Positions(db, tenantId, period, base.postedKeys), period)
  const own = deriveEntries({ loans, period, accounts, vat, heldBack: unsupportedIds, extraSources, ...base })
  const opening = isGoLive ? openingEntry(positions, period, accounts) : null
  const entries = opening ? [opening, ...own] : own
  const totals = verifyBalanced(entries)
  const reconciliation = compareBooks(journalBook(base.posted, base.postedLoans, own), await independentBook(db, tenantId, period.end))
  // A contract left out of the preview would fail its own controls by construction: its refusal is the unsupported one.
  const controls = assetFinance.loans.length === 0 ? [] : (await assetFinanceControls(db, tenantId, period.end, journalByKey(base.posted, base.postedLoans, own))).filter((c) => !unsupportedIds.has(c.key))
  const unconfirmed = [...ASSET_FINANCE_ROLES, ...IFRS9_ROLES].filter((role) => !(settings.mappingConfirmedRoles ?? []).includes(role) && entries.some((e) => e.lines.some((l) => l.role === role)))

  let refusal: PeriodPlan["refusal"] = null
  if (!periodHasEnded(period, now)) refusal = { code: "PERIOD_NOT_ENDED", message: `${period.label} has not ended; a month closes once it is over` }
  else if (!settings.mappingConfirmedAt) refusal = { code: "MAPPING_NOT_CONFIRMED", message: "Review and confirm the chart-of-accounts mapping first" }
  else if (unconfirmed.length > 0) refusal = { code: "MAPPING_NOT_CONFIRMED", message: `This month posts asset-finance or IFRS 9 accounts that were not in the mapping you confirmed (${unconfirmed.join(", ")}): review and confirm the mapping again` }
  else refusal = await orderRefusal(db, tenantId, period, settings.goLiveMonth)
  if (!refusal) {
    refusal = await ifrs9RunRefusal(db, tenantId, period)
  }
  if (!refusal && unsupported.length > 0) {
    refusal = { code: "AF_SOURCE_UNSUPPORTED", message: `Asset-finance contracts the export cannot post yet: ${unsupported.slice(0, 3).map((u) => u.message).join("; ")}` }
  }
  if (!refusal && reconciliation.mismatches.length > 0) {
    const sample = reconciliation.mismatches.slice(0, 3).map((m) => `${m.reference} (journal ${m.journalCents}, owed ${m.bookCents})`).join("; ")
    refusal = { code: "RECONCILIATION_FAILED", message: `The journal loan book does not tie to what borrowers owe for ${reconciliation.mismatches.length} loan(s): ${sample}` }
  }
  if (!refusal && controls.length > 0) {
    const sample = controls.slice(0, 3).map((c) => `${c.control} ${c.key} (journal ${c.journalCents}, books ${c.bookCents})`).join("; ")
    refusal = { code: "AF_CONTROL_FAILED", message: `${controls.length} asset-finance control(s) do not tie: ${sample}` }
  }
  return { period, isGoLive, entries, positions, totals, reconciliation, controls, refusal }
}
