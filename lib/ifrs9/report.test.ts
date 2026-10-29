import { describe, expect, it } from "vitest"
import { summariseStages, transitionMatrix, type ReportRow } from "./report"

const row = (loanId: string, stage: 1 | 2 | 3, eadCents: number, eclCents: number, suspended = 0, net = 0): ReportRow => ({
  loanId, stage, eadCents, eclCents, suspendedCents: suspended, netAdjustmentCents: net,
})

describe("summariseStages", () => {
  const rows = [row("a", 1, 1_000_000, 9_000), row("b", 1, 500_000, 4_500), row("c", 2, 400_000, 60_000), row("d", 3, 300_000, 180_000, 25_000, 6_000)]

  it("counts loans and totals exposure, ECL and interest in suspense by stage, with coverage in basis points", () => {
    const s = summariseStages(rows)
    expect(s.byStage).toEqual([
      { stage: 1, loans: 2, eadCents: 1_500_000, eclCents: 13_500, coverageBps: 90, suspendedCents: 0, netAdjustmentCents: 0 },
      { stage: 2, loans: 1, eadCents: 400_000, eclCents: 60_000, coverageBps: 1500, suspendedCents: 0, netAdjustmentCents: 0 },
      { stage: 3, loans: 1, eadCents: 300_000, eclCents: 180_000, coverageBps: 6000, suspendedCents: 25_000, netAdjustmentCents: 6_000 },
    ])
    // 253 500 / 2 200 000 = 11.52%
    expect(s.total).toEqual({ loans: 4, eadCents: 2_200_000, eclCents: 253_500, coverageBps: 1152, suspendedCents: 25_000, netAdjustmentCents: 6_000 })
  })

  it("reports a stage with no loans as zeros and an empty book as zero coverage", () => {
    expect(summariseStages([]).byStage.map((x) => [x.stage, x.loans, x.coverageBps])).toEqual([[1, 0, 0], [2, 0, 0], [3, 0, 0]])
    expect(summariseStages([]).total.coverageBps).toBe(0)
  })
})

describe("transitionMatrix", () => {
  const previous = [row("a", 1, 100, 1), row("b", 1, 200, 2), row("c", 2, 300, 30), row("d", 3, 400, 240), row("gone", 2, 50, 5)]
  const current = [row("a", 1, 90, 1), row("b", 2, 210, 31), row("c", 3, 320, 192), row("d", 2, 380, 57), row("fresh", 1, 70, 1)]

  it("counts each loan once from its previous stage to its current stage, with new and closed loans at the edges", () => {
    const m = transitionMatrix(previous, current)
    const cell = (from: string, to: string) => m.cells.find((c) => c.from === from && c.to === to)
    expect(cell("1", "1")).toEqual({ from: "1", to: "1", loans: 1, fromEadCents: 100, toEadCents: 90 })
    expect(cell("1", "2")).toEqual({ from: "1", to: "2", loans: 1, fromEadCents: 200, toEadCents: 210 })
    expect(cell("2", "3")).toEqual({ from: "2", to: "3", loans: 1, fromEadCents: 300, toEadCents: 320 })
    expect(cell("3", "2")).toEqual({ from: "3", to: "2", loans: 1, fromEadCents: 400, toEadCents: 380 })
    expect(cell("NEW", "1")).toEqual({ from: "NEW", to: "1", loans: 1, fromEadCents: 0, toEadCents: 70 })
    expect(cell("2", "CLOSED")).toEqual({ from: "2", to: "CLOSED", loans: 1, fromEadCents: 50, toEadCents: 0 })
    expect(m.cells).toHaveLength(6)
  })

  it("separates deterioration from improvement", () => {
    const m = transitionMatrix(previous, current)
    expect(m.deteriorated).toBe(2)
    expect(m.improved).toBe(1)
    expect(m.unchanged).toBe(1)
  })

  it("is every loan of both runs accounted for exactly once", () => {
    const m = transitionMatrix(previous, current)
    expect(m.cells.reduce((sum, c) => sum + c.loans, 0)).toBe(6)
  })
})
