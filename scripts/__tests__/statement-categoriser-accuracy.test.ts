/** The categoriser's accuracy-gate arithmetic (scripts/statement-categoriser-accuracy.ts), on invented keys. */
import { describe, expect, it } from "vitest"
import { gateClass, score, type Scored } from "../statement-categoriser-accuracy"

const k = (rows: number, label: Scored["label"], predicted: Scored["predicted"]): Scored => ({ key: `${label}-${predicted}-${rows}`, rows, label, predicted })

describe("the §6.4 gate", () => {
  it("combines the living categories and names the three gated ones", () => {
    expect([gateClass("FOOD"), gateClass("HOUSING"), gateClass("GAMBLING"), gateClass("BANK_FEES"), gateClass("UNCATEGORISED")])
      .toEqual(["LIVING", "LIVING", "GAMBLING", "OTHER", "OTHER"])
  })

  it("weights by rows, counts living-vs-not as an error, and leaves out keys neither side gated", () => {
    const s = score([
      k(80, "FOOD", "CLOTHING"), // living either way: agrees
      k(10, "FOOD", "UNCATEGORISED"), // living vs not: error
      k(5, "BANK_FEES", "GAMBLING"), // a false gambling call: error
      k(1000, "BANK_FEES", "UNCATEGORISED"), // neither gated: not in scope
    ])
    expect(s).toMatchObject({ inScopeRows: 95, agreeingRows: 80, allRows: 1095 })
    expect(s.gate).toBeCloseTo(80 / 95)
    expect(s.disagreements.map((d) => d.rows)).toEqual([10, 5])
  })

  it("fails closed with nothing in scope", () => {
    expect(score([]).gate).toBe(0)
  })
})
