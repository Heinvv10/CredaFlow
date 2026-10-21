/**
 * Shared counting for the decision-performance dashboard (DESIGN.md §6). Pure.
 *
 * One rule throughout: a rate divides OBSERVED trues by OBSERVED rows. A
 * PENDING row (window not yet elapsed) and an UNOBSERVABLE row (history gap)
 * are counted beside the rate, never inside it, so neither can pass as a good
 * outcome. A decision with no row for the metric (the nightly job has not run
 * since it was made) counts against coverage like a gap.
 */
import type { DecisionOutcomeState } from "@prisma/client"
import { NEVER_30_DPD } from "../outcomes/definition"

/** Cells built on fewer loans than this are greyed with their counts (DESIGN.md §6). */
export const SMALL_CELL_LOANS = 20

export interface OutcomeRow {
  outcomeKind: string
  window: string
  state: DecisionOutcomeState
  value: boolean | null
  reasonCode: string | null
}

export interface Tally {
  /** Decisions in the cell. */
  n: number
  /** OBSERVED true. */
  yes: number
  /** OBSERVED false (for CURED: delinquent and not cured). */
  no: number
  pending: number
  unobservable: number
  /** No row for this metric yet (counted against coverage). */
  notComputed: number
  /** CURED and SETTLED_AFTER_DELINQUENCY only: OBSERVED false because the loan never reached 30 DPD; outside the rate. */
  notDelinquent: number
  /** yes ÷ (yes + no), 0..100; null when nothing is observed. */
  ratePct: number | null
  /** OBSERVED ÷ (n − pending), 0..100; null while nothing has matured. */
  coveragePct: number | null
}

export const pct = (k: number, n: number): number | null => (n === 0 ? null : (100 * k) / n)

/**
 * Tally one metric (outcome kind and window) over a cell's decisions. Each
 * entry is one decision's rows; the first row matching the metric is used
 * (the loan-level kinds carry one row per decision and window).
 */
export function tally(decisions: readonly (readonly OutcomeRow[])[], outcomeKind: string, window: string): Tally {
  const t: Tally = { n: 0, yes: 0, no: 0, pending: 0, unobservable: 0, notComputed: 0, notDelinquent: 0, ratePct: null, coveragePct: null }
  for (const rows of decisions) {
    t.n++
    const row = rows.find((r) => r.outcomeKind === outcomeKind && r.window === window)
    if (!row) t.notComputed++
    else if (row.state === "PENDING") t.pending++
    else if (row.state === "UNOBSERVABLE") t.unobservable++
    else if (row.value === true) t.yes++
    else if (row.reasonCode === NEVER_30_DPD) t.notDelinquent++
    else t.no++
  }
  const observed = t.yes + t.no + t.notDelinquent
  t.ratePct = pct(t.yes, t.yes + t.no)
  t.coveragePct = pct(observed, t.n - t.pending)
  return t
}

export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = out.get(k)
    if (list) list.push(row)
    else out.set(k, [row])
  }
  return out
}
