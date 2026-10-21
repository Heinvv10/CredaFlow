/**
 * Outcome metrics (DESIGN.md §5). Pure.
 *
 * - Coverage: decisions with an OBSERVED outcome ÷ decisions whose window has
 *   matured (PENDING excluded), per decision kind and SAST month of the
 *   decision. UNOBSERVABLE counts against coverage and is listed by reason.
 * - Calibration: only decisions that carry a predictedProbability (none do
 *   today: no model produces one) with an OBSERVED headline outcome. Per model
 *   version and month: Brier score and ten probability buckets of width 0.1
 *   with the observed bad rate and a 95% Wilson interval. A bureau score is a
 *   band, not a probability, and never enters here.
 */
import type { DecisionOutcomeState, DecisionRecordKind } from "@prisma/client"
import { sastCalendarDate } from "@/lib/date/sast"

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = out.get(k)
    if (list) list.push(row)
    else out.set(k, [row])
  }
  return out
}

export interface CoverageInput {
  decisionRecordId: string
  decisionKind: DecisionRecordKind
  decidedAt: Date
  state: DecisionOutcomeState
  reasonCode: string | null
}

export interface CoverageCell {
  decisionKind: DecisionRecordKind
  /** SAST `yyyy-mm` of the decision. */
  month: string
  decisions: number
  pending: number
  matured: number
  observed: number
  unobservable: number
  /** observed ÷ matured, 0..100; null while nothing has matured. */
  coveragePct: number | null
  unobservableReasons: Record<string, number>
}

/**
 * Pass the rows of ONE outcome kind and window. A decision with several rows
 * (one per instalment, say) is matured when any row is, and observed only
 * when every matured row is OBSERVED.
 */
export function outcomeCoverage(rows: readonly CoverageInput[]): CoverageCell[] {
  const byDecision = groupBy(rows, (r) => r.decisionRecordId)
  const cells = new Map<string, CoverageCell>()
  for (const decisionRows of byDecision.values()) {
    const first = decisionRows[0]
    const month = sastCalendarDate(first.decidedAt).slice(0, 7)
    const k = `${first.decisionKind}|${month}`
    const cell = cells.get(k) ?? {
      decisionKind: first.decisionKind, month, decisions: 0, pending: 0, matured: 0, observed: 0, unobservable: 0, coveragePct: null, unobservableReasons: {},
    }
    cells.set(k, cell)
    cell.decisions++
    const matured = decisionRows.filter((r) => r.state !== "PENDING")
    if (matured.length === 0) { cell.pending++; continue }
    cell.matured++
    const gaps = matured.filter((r) => r.state === "UNOBSERVABLE")
    if (gaps.length === 0) { cell.observed++; continue }
    cell.unobservable++
    for (const reason of new Set(gaps.map((g) => g.reasonCode ?? "UNKNOWN"))) {
      cell.unobservableReasons[reason] = (cell.unobservableReasons[reason] ?? 0) + 1
    }
  }
  return [...cells.values()]
    .map((c) => ({ ...c, coveragePct: c.matured === 0 ? null : (100 * c.observed) / c.matured }))
    .sort((a, b) => a.decisionKind.localeCompare(b.decisionKind) || a.month.localeCompare(b.month))
}

export interface CalibrationInput {
  modelVersion: string | null
  decidedAt: Date
  predictedProbability: number | null
  /** The headline outcome (ever 90+ DPD in 12 months); null unless OBSERVED. */
  bad: boolean | null
}

export interface CalibrationBucket {
  /** Probabilities in [lower, upper); the last bucket includes 1. */
  lower: number
  upper: number
  n: number
  meanPredicted: number
  observedBadRate: number
  wilson95: { low: number; high: number }
}

export interface CalibrationCell {
  modelVersion: string
  month: string
  n: number
  brier: number
  buckets: CalibrationBucket[]
}

/** 95% Wilson score interval for k successes in n trials. */
export function wilsonInterval(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 }
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

export function calibration(rows: readonly CalibrationInput[]): CalibrationCell[] {
  const scored = rows.filter((r): r is CalibrationInput & { predictedProbability: number; bad: boolean } =>
    r.predictedProbability !== null && r.bad !== null)
  const groups = groupBy(scored, (r) => `${r.modelVersion ?? "unversioned"}|${sastCalendarDate(r.decidedAt).slice(0, 7)}`)
  return [...groups.entries()].map(([k, group]) => {
    const [modelVersion, month] = k.split("|")
    const y = (r: (typeof group)[number]) => (r.bad ? 1 : 0)
    const brier = group.reduce((s, r) => s + (r.predictedProbability - y(r)) ** 2, 0) / group.length
    const buckets: CalibrationBucket[] = []
    for (let b = 0; b < 10; b++) {
      const inBucket = group.filter((r) => Math.min(9, Math.floor(r.predictedProbability * 10)) === b)
      if (inBucket.length === 0) continue
      const bads = inBucket.filter((r) => r.bad).length
      buckets.push({
        lower: b / 10, upper: (b + 1) / 10, n: inBucket.length,
        meanPredicted: inBucket.reduce((s, r) => s + r.predictedProbability, 0) / inBucket.length,
        observedBadRate: bads / inBucket.length,
        wilson95: wilsonInterval(bads, inBucket.length),
      })
    }
    return { modelVersion, month, n: group.length, brier, buckets }
  }).sort((a, b) => a.modelVersion.localeCompare(b.modelVersion) || a.month.localeCompare(b.month))
}
