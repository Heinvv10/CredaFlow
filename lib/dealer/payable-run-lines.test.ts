import { describe, expect, it } from "vitest"
import { selectRunLines, type RunCandidate } from "./payable-run-lines"

const earned = (id: string, net: number, reversal: RunCandidate["reversal"] = null): RunCandidate => ({
  id, kind: "EARNED", netCents: net, vatCents: Math.round(net * 0.15), grossCents: net + Math.round(net * 0.15), reversal,
})
const reversedOf = (line: RunCandidate, id: string): RunCandidate => ({
  id, kind: "REVERSED", netCents: -line.netCents, vatCents: -line.vatCents, grossCents: -line.grossCents, reversal: null,
})

describe("selectRunLines (the run-create netting rule)", () => {
  it("takes every EARNED line with no reversal and totals them", () => {
    expect(selectRunLines([earned("e1", 1_000), earned("e2", 2_000)], "2026-09-30")).toEqual({
      lineIds: ["e1", "e2"], totalNetCents: 3_000, totalVatCents: 450, totalGrossCents: 3_450,
    })
  })

  it("links a clawback with its commission, the REVERSED line first, netting to nothing", () => {
    const e1 = earned("e1", 1_000, { id: "r1", effectiveOn: "2026-09-20", live: false })
    const selection = selectRunLines([e1, reversedOf(e1, "r1"), earned("e2", 2_000)], "2026-09-30")
    expect(selection.lineIds).toEqual(["r1", "e1", "e2"])
    expect(selection.totalNetCents).toBe(2_000)
  })

  it("leaves out a commission whose clawback falls after the period end", () => {
    const e1 = earned("e1", 1_000, { id: "r1", effectiveOn: "2026-10-05", live: false })
    expect(selectRunLines([e1, earned("e2", 2_000)], "2026-09-30").lineIds).toEqual(["e2"])
  })

  it("leaves out a commission whose clawback sits in another live run", () => {
    const e1 = earned("e1", 1_000, { id: "r1", effectiveOn: "2026-09-20", live: true })
    expect(selectRunLines([e1], "2026-09-30").lineIds).toEqual([])
  })

  it("takes a clawback alone when its commission was paid in an earlier run (net may be negative)", () => {
    const paid = earned("e0", 1_000)
    const selection = selectRunLines([reversedOf(paid, "r0")], "2026-09-30")
    expect(selection).toMatchObject({ lineIds: ["r0"], totalNetCents: -1_000 })
  })
})
