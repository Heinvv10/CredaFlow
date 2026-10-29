/**
 * The staging summary (count, exposure, ECL and interest in suspense by stage)
 * and the transition matrix between two runs. Pure; run-report.ts reads them.
 */
import { STAGES, type Stage } from "./types"

export interface ReportRow {
  loanId: string
  stage: Stage
  eadCents: number
  eclCents: number
  /** Interest held in suspense: contractual plus default interest. */
  suspendedCents: number
}

export interface StageTotals {
  loans: number
  eadCents: number
  eclCents: number
  /** ECL as a share of exposure, basis points, nearest. */
  coverageBps: number
  suspendedCents: number
}

export interface StageSummary {
  byStage: Array<StageTotals & { stage: Stage }>
  total: StageTotals
}

const coverage = (ecl: number, ead: number) => (ead > 0 ? Math.round((ecl * 10_000) / ead) : 0)

function totals(rows: readonly ReportRow[]): StageTotals {
  const eadCents = rows.reduce((s, r) => s + r.eadCents, 0)
  const eclCents = rows.reduce((s, r) => s + r.eclCents, 0)
  return { loans: rows.length, eadCents, eclCents, coverageBps: coverage(eclCents, eadCents), suspendedCents: rows.reduce((s, r) => s + r.suspendedCents, 0) }
}

export function summariseStages(rows: readonly ReportRow[]): StageSummary {
  return { byStage: STAGES.map((stage) => ({ stage, ...totals(rows.filter((r) => r.stage === stage)) })), total: totals(rows) }
}

export type TransitionEdge = "1" | "2" | "3" | "NEW" | "CLOSED"

export interface TransitionCell {
  from: TransitionEdge
  to: TransitionEdge
  loans: number
  /** Exposure at the earlier run (0 for a new loan) and at the later one (0 for a closed loan). */
  fromEadCents: number
  toEadCents: number
}

export interface TransitionMatrix {
  cells: TransitionCell[]
  deteriorated: number
  improved: number
  unchanged: number
}

/** `previous` and `current` are two runs of one lender; a loan in only one is NEW or CLOSED. */
export function transitionMatrix(previous: readonly ReportRow[], current: readonly ReportRow[]): TransitionMatrix {
  const before = new Map(previous.map((r) => [r.loanId, r]))
  const after = new Map(current.map((r) => [r.loanId, r]))
  const cells = new Map<string, TransitionCell>()
  let deteriorated = 0
  let improved = 0
  let unchanged = 0
  const add = (from: TransitionEdge, to: TransitionEdge, fromEad: number, toEad: number) => {
    const key = `${from}>${to}`
    const cell = cells.get(key) ?? { from, to, loans: 0, fromEadCents: 0, toEadCents: 0 }
    cell.loans += 1
    cell.fromEadCents += fromEad
    cell.toEadCents += toEad
    cells.set(key, cell)
  }
  for (const [loanId, then] of before) {
    const now = after.get(loanId)
    if (!now) { add(String(then.stage) as TransitionEdge, "CLOSED", then.eadCents, 0); continue }
    add(String(then.stage) as TransitionEdge, String(now.stage) as TransitionEdge, then.eadCents, now.eadCents)
    if (now.stage > then.stage) deteriorated += 1
    else if (now.stage < then.stage) improved += 1
    else unchanged += 1
  }
  for (const [loanId, now] of after) if (!before.has(loanId)) add("NEW", String(now.stage) as TransitionEdge, 0, now.eadCents)
  const order = ["NEW", "1", "2", "3", "CLOSED"]
  return { cells: [...cells.values()].sort((a, b) => order.indexOf(a.from) - order.indexOf(b.from) || order.indexOf(a.to) - order.indexOf(b.to)), deteriorated, improved, unchanged }
}
