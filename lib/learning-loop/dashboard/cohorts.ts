/**
 * Approval-to-outcome cohorts (DESIGN.md §6). Pure.
 *
 * The population is the final approvals that produced a loan (the records the
 * outcome job attaches loan outcomes to, DESIGN.md §3 "Attribution"), grouped
 * by SAST disbursal month × ruleVersion × policyHash × score band × overridden
 * × product. Each cell carries ever 30/60/90+ DPD (90+ is the headline bad),
 * cured, settled and written off in the chosen window, with PENDING and
 * UNOBSERVABLE counted separately and the coverage of the headline. A metric
 * the window does not measure (EVER_90_DPD at 3M, DESIGN.md §3) is null: not
 * a gap, and not shown as one.
 */
import { windowThresholds } from "../outcomes/definition"
import { SMALL_CELL_LOANS, groupBy, tally, type OutcomeRow, type Tally } from "./cells"

export const COHORT_WINDOWS = ["3M", "6M", "12M"] as const
export type CohortWindow = (typeof COHORT_WINDOWS)[number]

export const COHORT_METRICS = [
  { key: "ever30", outcomeKind: "EVER_30_DPD", label: "Ever 30+ DPD" },
  { key: "ever60", outcomeKind: "EVER_60_DPD", label: "Ever 60+ DPD" },
  { key: "ever90", outcomeKind: "EVER_90_DPD", label: "Ever 90+ DPD" },
  { key: "cured", outcomeKind: "CURED", label: "Cured" },
  { key: "settled", outcomeKind: "SETTLED", label: "Settled" },
  { key: "writtenOff", outcomeKind: "WRITTEN_OFF", label: "Written off" },
] as const
export type CohortMetricKey = (typeof COHORT_METRICS)[number]["key"]
export type CohortMetrics = Record<CohortMetricKey, Tally | null>

const measured = (outcomeKind: string, window: CohortWindow) =>
  !outcomeKind.startsWith("EVER_") || windowThresholds(window).some((t) => t.kind === outcomeKind)

/** The deepest DPD threshold a window measures: coverage, pending and unobservable are read on it. */
export const coverageTally = (metrics: CohortMetrics): Tally => (metrics.ever90 ?? metrics.ever60) as Tally

/** Shown where a record carries no bureau band (asset finance, or no score). */
export const NO_SCORE_BAND = "No band"

export interface ApprovalInput {
  decisionRecordId: string
  /** SAST `yyyy-mm` of disbursement. */
  cohortMonth: string
  ruleVersion: string
  policyHash: string
  scoreBand: string
  overridden: boolean
  product: string
  outcomes: readonly OutcomeRow[]
}

export interface CohortCell {
  cohortMonth: string
  ruleVersion: string
  policyHash: string
  scoreBand: string
  overridden: boolean
  product: string
  loans: number
  /** Fewer than SMALL_CELL_LOANS loans: shown greyed, with counts. */
  small: boolean
  metrics: CohortMetrics
}

export interface OverrideCell {
  cohortMonth: string
  overridden: boolean
  loans: number
  small: boolean
  metrics: CohortMetrics
}

function metricsOf(group: readonly ApprovalInput[], window: CohortWindow): CohortMetrics {
  const rows = group.map((a) => a.outcomes)
  return Object.fromEntries(COHORT_METRICS.map((m) => [m.key, measured(m.outcomeKind, window) ? tally(rows, m.outcomeKind, window) : null])) as CohortMetrics
}

const newestFirst = (a: { cohortMonth: string }, b: { cohortMonth: string }) => b.cohortMonth.localeCompare(a.cohortMonth)

export function approvalCohorts(approvals: readonly ApprovalInput[], window: CohortWindow): CohortCell[] {
  const groups = groupBy(approvals, (a) =>
    [a.cohortMonth, a.ruleVersion, a.policyHash, a.scoreBand, a.overridden, a.product].join("\u0000"))
  return [...groups.values()].map((group) => {
    const { cohortMonth, ruleVersion, policyHash, scoreBand, overridden, product } = group[0]
    return {
      cohortMonth, ruleVersion, policyHash, scoreBand, overridden, product,
      loans: group.length, small: group.length < SMALL_CELL_LOANS, metrics: metricsOf(group, window),
    }
  }).sort((a, b) => newestFirst(a, b)
    || a.ruleVersion.localeCompare(b.ruleVersion) || a.policyHash.localeCompare(b.policyHash)
    || a.scoreBand.localeCompare(b.scoreBand) || Number(a.overridden) - Number(b.overridden) || a.product.localeCompare(b.product))
}

/** Overrides beside non-overrides on the same disbursal cohort. */
export function overrideComparison(approvals: readonly ApprovalInput[], window: CohortWindow): OverrideCell[] {
  const groups = groupBy(approvals, (a) => `${a.cohortMonth}|${a.overridden}`)
  return [...groups.values()].map((group) => ({
    cohortMonth: group[0].cohortMonth, overridden: group[0].overridden,
    loans: group.length, small: group.length < SMALL_CELL_LOANS, metrics: metricsOf(group, window),
  })).sort((a, b) => newestFirst(a, b) || Number(a.overridden) - Number(b.overridden))
}

/** The whole population in one cell: the page's headline figures. */
export function cohortTotals(approvals: readonly ApprovalInput[], window: CohortWindow): CohortMetrics {
  return metricsOf(approvals, window)
}
