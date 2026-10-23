import { describe, expect, it } from "vitest"
import { calibration, outcomeCoverage, wilsonInterval, type CalibrationInput, type CoverageInput } from "./metrics"

const jan = new Date("2026-01-15T09:00:00+02:00")
const feb = new Date("2026-02-15T09:00:00+02:00")
const row = (id: string, state: CoverageInput["state"], decidedAt = jan, reasonCode: string | null = null): CoverageInput =>
  ({ decisionRecordId: id, decisionKind: "CREDIT_DECISION", decidedAt, state, reasonCode })

describe("outcomeCoverage", () => {
  it("is observed ÷ matured per kind and month; PENDING is excluded and UNOBSERVABLE counts against it by reason", () => {
    const cells = outcomeCoverage([
      row("d1", "OBSERVED"), row("d2", "OBSERVED"), row("d3", "UNOBSERVABLE", jan, "HISTORY_GAP"), row("d4", "PENDING"),
      row("d5", "PENDING", feb),
    ])
    expect(cells).toEqual([
      { decisionKind: "CREDIT_DECISION", month: "2026-01", decisions: 4, pending: 1, matured: 3, observed: 2, unobservable: 1,
        coveragePct: (100 * 2) / 3, unobservableReasons: { HISTORY_GAP: 1 } },
      { decisionKind: "CREDIT_DECISION", month: "2026-02", decisions: 1, pending: 1, matured: 0, observed: 0, unobservable: 0,
        coveragePct: null, unobservableReasons: {} },
    ])
  })

  it("counts a decision with several rows once: observed only when every matured row is", () => {
    const [cell] = outcomeCoverage([
      row("d1", "OBSERVED"), row("d1", "PENDING"),
      row("d2", "OBSERVED"), row("d2", "UNOBSERVABLE", jan, "PAID_AT_MISSING"),
    ])
    expect(cell).toMatchObject({ decisions: 2, matured: 2, observed: 1, unobservable: 1, coveragePct: 50, unobservableReasons: { PAID_AT_MISSING: 1 } })
  })

  it("is 100% when every matured decision is observed", () => {
    expect(outcomeCoverage([row("d1", "OBSERVED"), row("d2", "OBSERVED")])[0].coveragePct).toBe(100)
  })
})

describe("wilsonInterval", () => {
  it("matches the published 95% values", () => {
    const { low, high } = wilsonInterval(5, 10)
    expect(low).toBeCloseTo(0.2366, 4)
    expect(high).toBeCloseTo(0.7634, 4)
    const zero = wilsonInterval(0, 20)
    expect(zero.low).toBe(0)
    expect(zero.high).toBeCloseTo(0.1611, 4)
  })
})

describe("calibration", () => {
  const p = (predictedProbability: number | null, bad: boolean | null, modelVersion: string | null = "synthetic-v1", decidedAt = jan): CalibrationInput =>
    ({ modelVersion, decidedAt, predictedProbability, bad })

  it("is empty when no decision carries a probability (every decision today)", () => {
    expect(calibration([p(null, true), p(null, false)])).toEqual([])
  })

  it("leaves out decisions whose headline outcome is not observed", () => {
    expect(calibration([p(0.2, null)])).toEqual([])
  })

  it("computes the Brier score and probability buckets with Wilson intervals", () => {
    const rows = [p(0.05, false), p(0.05, false), p(0.15, true), p(0.15, false), p(0.95, true), p(1, true)]
    const [cell] = calibration(rows)
    const brier = (0.05 ** 2 * 2 + 0.85 ** 2 + 0.15 ** 2 + 0.05 ** 2 + 0) / 6
    expect(cell.modelVersion).toBe("synthetic-v1")
    expect(cell.month).toBe("2026-01")
    expect(cell.n).toBe(6)
    expect(cell.brier).toBeCloseTo(brier, 10)
    expect(cell.buckets.map((b) => [b.lower, b.upper, b.n, b.observedBadRate])).toEqual([[0, 0.1, 2, 0], [0.1, 0.2, 2, 0.5], [0.9, 1, 2, 1]])
    expect(cell.buckets[1].meanPredicted).toBeCloseTo(0.15, 10)
    expect(cell.buckets[1].wilson95).toEqual(wilsonInterval(1, 2))
  })

  it("splits by model version and month", () => {
    const cells = calibration([p(0.1, false, "a"), p(0.1, false, "b"), p(0.1, true, "a", feb)])
    expect(cells.map((c) => [c.modelVersion, c.month, c.n])).toEqual([["a", "2026-01", 1], ["a", "2026-02", 1], ["b", "2026-01", 1]])
  })
})
