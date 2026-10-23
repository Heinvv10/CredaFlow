import { describe, expect, it } from "vitest"
import { tally, type OutcomeRow } from "./cells"
import { approvalCohorts, cohortTotals, coverageTally, overrideComparison, type ApprovalInput } from "./cohorts"

// Synthetic approvals only: ids, versions and hashes are made up.
const obs = (outcomeKind: string, value: boolean, reasonCode: string | null = null, window = "12M"): OutcomeRow =>
  ({ outcomeKind, window, state: "OBSERVED", value, reasonCode })
const pendingRow = (outcomeKind: string, window = "12M"): OutcomeRow => ({ outcomeKind, window, state: "PENDING", value: null, reasonCode: null })
const gap = (outcomeKind: string, window = "12M"): OutcomeRow => ({ outcomeKind, window, state: "UNOBSERVABLE", value: null, reasonCode: "HISTORY_GAP" })

let seq = 0
const approval = (outcomes: OutcomeRow[], over: Partial<ApprovalInput> = {}): ApprovalInput => ({
  decisionRecordId: `dec-${++seq}`, cohortMonth: "2026-03", ruleVersion: "decision-log-v1+approval-ndi-v3",
  policyHash: "a".repeat(64), scoreBand: "630-679", overridden: false, product: "MICRO", outcomes, ...over,
})

describe("tally", () => {
  it("divides observed trues by observed rows; pending and unobservable sit beside the rate, never inside it", () => {
    const t = tally([[obs("EVER_90_DPD", true)], [obs("EVER_90_DPD", false)], [obs("EVER_90_DPD", false)],
      [pendingRow("EVER_90_DPD")], [gap("EVER_90_DPD")]], "EVER_90_DPD", "12M")
    expect(t).toMatchObject({ n: 5, yes: 1, no: 2, pending: 1, unobservable: 1, notComputed: 0 })
    expect(t.ratePct).toBeCloseTo(100 / 3)
    // Matured = 5 − 1 pending; the gap counts against coverage.
    expect(t.coveragePct).toBe(75)
  })

  it("never counts a gap as good: a cell of gaps has no rate at all", () => {
    const t = tally([[gap("EVER_90_DPD")], [gap("EVER_90_DPD")]], "EVER_90_DPD", "12M")
    expect(t).toMatchObject({ yes: 0, no: 0, ratePct: null, coveragePct: 0 })
  })

  it("counts a decision with no row for the metric against coverage, not as good", () => {
    const t = tally([[obs("EVER_90_DPD", false)], []], "EVER_90_DPD", "12M")
    expect(t).toMatchObject({ yes: 0, no: 1, notComputed: 1, ratePct: 0, coveragePct: 50 })
  })

  it("has no coverage while everything is pending", () => {
    expect(tally([[pendingRow("EVER_90_DPD")]], "EVER_90_DPD", "12M")).toMatchObject({ ratePct: null, coveragePct: null, pending: 1 })
  })

  it("divides the cure rate by delinquent loans only", () => {
    const t = tally([[obs("CURED", true)], [obs("CURED", false)], [obs("CURED", false, "NEVER_30_DPD")], [obs("CURED", false, "NEVER_30_DPD")]], "CURED", "12M")
    expect(t).toMatchObject({ yes: 1, no: 1, notDelinquent: 2, ratePct: 50, coveragePct: 100 })
  })

  it("reads only the asked window", () => {
    const t = tally([[obs("EVER_90_DPD", true, null, "3M"), pendingRow("EVER_90_DPD", "12M")]], "EVER_90_DPD", "3M")
    expect(t).toMatchObject({ yes: 1, pending: 0, ratePct: 100 })
  })
})

describe("approvalCohorts", () => {
  it("groups by month × rule version × policy × score band × override × product, newest first", () => {
    const cells = approvalCohorts([
      approval([obs("EVER_90_DPD", true)]),
      approval([obs("EVER_90_DPD", false)]),
      approval([obs("EVER_90_DPD", false)], { policyHash: "b".repeat(64) }),
      approval([obs("EVER_90_DPD", false)], { cohortMonth: "2026-04", overridden: true }),
      approval([obs("EVER_90_DPD", false)], { scoreBand: "No band", product: "ASSET_FINANCE" }),
    ], "12M")
    expect(cells.map((c) => [c.cohortMonth, c.policyHash[0], c.scoreBand, c.overridden, c.product, c.loans])).toEqual([
      ["2026-04", "a", "630-679", true, "MICRO", 1],
      ["2026-03", "a", "630-679", false, "MICRO", 2],
      ["2026-03", "a", "No band", false, "ASSET_FINANCE", 1],
      ["2026-03", "b", "630-679", false, "MICRO", 1],
    ])
    expect(cells[1].metrics.ever90).toMatchObject({ yes: 1, no: 1, ratePct: 50 })
  })

  it("greys a cell under 20 loans and keeps its counts; 20 is not small", () => {
    const nineteen = Array.from({ length: 19 }, () => approval([obs("EVER_90_DPD", false)]))
    const [small] = approvalCohorts(nineteen, "12M")
    expect(small).toMatchObject({ loans: 19, small: true })
    expect(small.metrics.ever90).toMatchObject({ n: 19, no: 19 })
    const [big] = approvalCohorts([...nineteen, approval([obs("EVER_90_DPD", true)])], "12M")
    expect(big).toMatchObject({ loans: 20, small: false })
  })

  it("reports every metric for the chosen window", () => {
    const rows = [obs("EVER_30_DPD", true), obs("EVER_60_DPD", true), obs("EVER_90_DPD", false), obs("CURED", true),
      obs("SETTLED_AFTER_DELINQUENCY", false), obs("SETTLED", true), obs("WRITTEN_OFF", false)]
    const [cell] = approvalCohorts([approval(rows)], "12M")
    expect(Object.fromEntries(Object.entries(cell.metrics).map(([k, t]) => [k, t?.ratePct]))).toEqual({
      ever30: 100, ever60: 100, ever90: 0, cured: 100, settledAfterDelinquency: 0, settled: 100, writtenOff: 0,
    })
    expect(approvalCohorts([approval(rows)], "6M")[0].metrics.ever30).toMatchObject({ notComputed: 1, ratePct: null })
  })

  it("does not measure 90+ DPD at 3M (not a gap), and reads coverage on 60+ there", () => {
    const rows = [obs("EVER_60_DPD", false, null, "3M"), gap("EVER_30_DPD", "3M")]
    const [cell] = approvalCohorts([approval(rows), approval([pendingRow("EVER_60_DPD", "3M")])], "3M")
    expect(cell.metrics.ever90).toBeNull()
    expect(coverageTally(cell.metrics)).toMatchObject({ n: 2, no: 1, pending: 1, notComputed: 0, coveragePct: 100 })
    expect(coverageTally(approvalCohorts([approval([obs("EVER_90_DPD", true)])], "12M")[0].metrics)).toMatchObject({ yes: 1 })
  })
})

describe("overrideComparison and totals", () => {
  it("puts overrides beside non-overrides on the same disbursal month", () => {
    const cells = overrideComparison([
      approval([obs("EVER_90_DPD", true)], { overridden: true, scoreBand: "480-529" }),
      approval([obs("EVER_90_DPD", false)], { overridden: false, scoreBand: "680-709" }),
      approval([obs("EVER_90_DPD", false)], { overridden: false, product: "PERSONAL" }),
    ], "12M")
    expect(cells.map((c) => [c.cohortMonth, c.overridden, c.loans, c.metrics.ever90?.ratePct])).toEqual([
      ["2026-03", false, 2, 0], ["2026-03", true, 1, 100],
    ])
  })

  it("totals the whole population", () => {
    expect(cohortTotals([approval([obs("EVER_90_DPD", true)]), approval([pendingRow("EVER_90_DPD")])], "12M").ever90)
      .toMatchObject({ n: 2, yes: 1, pending: 1, ratePct: 100, coveragePct: 100 })
  })
})
