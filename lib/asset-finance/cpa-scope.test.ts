import { describe, expect, it } from "vitest"
import { CPA_JURISTIC_THRESHOLD_CENTS } from "./cpa-thresholds"
import { CPA_RULE_IDS, classifyCpaScope, type CpaScopeInput } from "./cpa-scope"

const T = CPA_JURISTIC_THRESHOLD_CENTS

const juristic = (over: Partial<Extract<CpaScopeInput, { lessee: "JURISTIC" }>> = {}): CpaScopeInput => ({
  lessee: "JURISTIC",
  entityType: "COMPANY",
  annualTurnoverCents: T - 1,
  totalAssetValueCents: T - 1,
  financialsEvidenceIds: ["doc-afs"],
  financialsVerified: true,
  ...over,
})

describe("classifyCpaScope", () => {
  it("the threshold is R2 million", () => {
    expect(T).toBe(200_000_000)
  })

  it.each<[string, CpaScopeInput, boolean, string]>([
    ["a natural person (sole proprietor)", { lessee: "NATURAL_PERSON" }, true, "CPA_NATURAL_PERSON"],
    ["a juristic person below the threshold on both figures", juristic(), true, "CPA_JURISTIC_UNDER_THRESHOLD"],
    ["turnover exactly at the threshold", juristic({ annualTurnoverCents: T }), false, "CPA_JURISTIC_OVER_THRESHOLD"],
    ["asset value at the threshold, turnover unknown", juristic({ annualTurnoverCents: null, totalAssetValueCents: T }), false, "CPA_JURISTIC_OVER_THRESHOLD"],
    ["one figure below, the other unknown", juristic({ totalAssetValueCents: null }), true, "CPA_FINANCIALS_UNPROVEN"],
    ["no figures", juristic({ annualTurnoverCents: null, totalAssetValueCents: null }), true, "CPA_FINANCIALS_UNPROVEN"],
    ["figures without evidence", juristic({ annualTurnoverCents: T * 5, financialsEvidenceIds: [] }), true, "CPA_FINANCIALS_UNPROVEN"],
    ["figures not verified", juristic({ annualTurnoverCents: T * 5, financialsVerified: false }), true, "CPA_FINANCIALS_UNPROVEN"],
    ["a trust over the threshold", juristic({ entityType: "TRUST", totalAssetValueCents: T + 1 }), false, "CPA_JURISTIC_OVER_THRESHOLD"],
  ])("%s", (_, input, applies, rule) => {
    const result = classifyCpaScope(input)
    expect({ applies: result.applies, rule: result.rule }).toEqual({ applies, rule })
    expect(CPA_RULE_IDS).toContain(result.rule)
    expect(result.reason.length).toBeGreaterThan(10)
  })

  it("cites the evidence the decision rests on", () => {
    expect(classifyCpaScope(juristic({ annualTurnoverCents: T })).evidenceIds).toEqual(["doc-afs"])
    expect(classifyCpaScope({ lessee: "NATURAL_PERSON" }).evidenceIds).toEqual([])
  })

  it("refuses a negative or fractional figure", () => {
    expect(() => classifyCpaScope(juristic({ annualTurnoverCents: -1 }))).toThrow(RangeError)
    expect(() => classifyCpaScope(juristic({ totalAssetValueCents: 1.5 }))).toThrow(RangeError)
  })
})
