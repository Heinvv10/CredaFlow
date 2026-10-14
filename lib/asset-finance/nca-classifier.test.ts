import { describe, expect, it } from "vitest"
import {
  classifyNcaRegime,
  type NcaClassifierInput,
  type NcaRuleId,
} from "@/lib/asset-finance/nca-classifier"
import {
  NCA_JURISTIC_THRESHOLD_CENTS,
  NCA_LARGE_AGREEMENT_THRESHOLD_CENTS,
} from "@/lib/asset-finance/nca-thresholds"

const R1M = NCA_JURISTIC_THRESHOLD_CENTS
const R250K = NCA_LARGE_AGREEMENT_THRESHOLD_CENTS

const natural = { kind: "NATURAL" as const }
const juristic = { kind: "JURISTIC" as const }

// A company that is proven, small and borrowing a small amount: the NCA base case.
function input(overrides: Partial<NcaClassifierInput> = {}): NcaClassifierInput {
  return {
    entityType: "COMPANY",
    trustees: [],
    annualTurnoverCents: 50_000_000,
    totalAssetValueCents: 40_000_000,
    financialsEvidenceIds: ["doc_test_afs_1"],
    financialsVerified: true,
    trusteeEvidenceIds: [],
    principalDebtCents: 10_000_000,
    ...overrides,
  }
}

function trust(overrides: Partial<NcaClassifierInput> = {}): NcaClassifierInput {
  return input({
    entityType: "TRUST",
    trusteeEvidenceIds: ["doc_test_loa_1"],
    ...overrides,
  })
}

describe("classifyNcaRegime", () => {
  it.each<[string, "NCA" | "NON_NCA", NcaRuleId, NcaClassifierInput]>([
    // Trusts
    ["trust, 1 natural trustee", "NCA", "TRUST_FEW_NATURAL_TRUSTEES", trust({ trustees: [natural] })],
    ["trust, 2 natural trustees", "NCA", "TRUST_FEW_NATURAL_TRUSTEES", trust({ trustees: [natural, natural] })],
    ["trust, 3 natural trustees, small → juristic small agreement", "NCA", "JURISTIC_SMALL_AGREEMENT", trust({ trustees: [natural, natural, natural] })],
    ["trust, 3 natural trustees, over R1m", "NON_NCA", "JURISTIC_OVER_THRESHOLD", trust({ trustees: [natural, natural, natural], annualTurnoverCents: R1M + 1 })],
    ["trust, 2 trustees one juristic, over R1m", "NON_NCA", "JURISTIC_OVER_THRESHOLD", trust({ trustees: [natural, juristic], totalAssetValueCents: R1M * 3 })],
    ["trust, 1 juristic trustee, large agreement", "NON_NCA", "LARGE_AGREEMENT", trust({ trustees: [juristic], principalDebtCents: R250K })],
    ["trust, no Letters of Authority", "NCA", "TRUST_UNEVIDENCED", trust({ trustees: [natural, natural, natural], trusteeEvidenceIds: [], annualTurnoverCents: R1M * 5 })],
    ["trust, no trustees recorded", "NCA", "TRUST_UNEVIDENCED", trust({ trustees: [], annualTurnoverCents: R1M * 5 })],
    ["trust, juristic but financials unverified", "NCA", "FINANCIALS_UNPROVEN", trust({ trustees: [juristic], financialsVerified: false, annualTurnoverCents: R1M * 5 })],

    // Company: R1m threshold
    ["company, turnover over R1m", "NON_NCA", "JURISTIC_OVER_THRESHOLD", input({ annualTurnoverCents: R1M + 1 })],
    ["company, turnover exactly R1m", "NON_NCA", "JURISTIC_OVER_THRESHOLD", input({ annualTurnoverCents: R1M, totalAssetValueCents: 0 })],
    ["company, assets exactly R1m, turnover null", "NON_NCA", "JURISTIC_OVER_THRESHOLD", input({ annualTurnoverCents: null, totalAssetValueCents: R1M })],
    ["company, turnover one cent under R1m", "NCA", "JURISTIC_SMALL_AGREEMENT", input({ annualTurnoverCents: R1M - 1, totalAssetValueCents: R1M - 1 })],
    ["company, assets over R1m, turnover under", "NON_NCA", "JURISTIC_OVER_THRESHOLD", input({ annualTurnoverCents: 10_000_000, totalAssetValueCents: R1M + 1 })],
    ["company, turnover over R1m, assets null", "NON_NCA", "JURISTIC_OVER_THRESHOLD", input({ annualTurnoverCents: R1M * 2, totalAssetValueCents: null })],

    // Company under R1m: R250k large-agreement threshold
    ["company under R1m, principal over R250k", "NON_NCA", "LARGE_AGREEMENT", input({ principalDebtCents: R250K + 1 })],
    ["company under R1m, principal exactly R250k", "NON_NCA", "LARGE_AGREEMENT", input({ principalDebtCents: R250K })],
    ["company under R1m, principal one cent under R250k", "NCA", "JURISTIC_SMALL_AGREEMENT", input({ principalDebtCents: R250K - 1 })],
    ["company under R1m, principal under R250k", "NCA", "JURISTIC_SMALL_AGREEMENT", input({ principalDebtCents: 5_000_000 })],

    // Unproven financials → NCA, even when the figures claim otherwise
    ["company, no financials evidence", "NCA", "FINANCIALS_UNPROVEN", input({ financialsEvidenceIds: [], annualTurnoverCents: R1M * 10 })],
    ["company, financials not verified", "NCA", "FINANCIALS_UNPROVEN", input({ financialsVerified: false, annualTurnoverCents: R1M * 10 })],
    ["company, financials not verified, large agreement", "NCA", "FINANCIALS_UNPROVEN", input({ financialsVerified: false, principalDebtCents: R250K * 4 })],
    ["company, both figures null", "NCA", "FINANCIALS_UNPROVEN", input({ annualTurnoverCents: null, totalAssetValueCents: null, principalDebtCents: R250K * 4 })],

    // CC and partnership follow the juristic rules; trustees are ignored
    ["CC, over R1m", "NON_NCA", "JURISTIC_OVER_THRESHOLD", input({ entityType: "CC", totalAssetValueCents: R1M * 2 })],
    ["CC, under R1m, large agreement", "NON_NCA", "LARGE_AGREEMENT", input({ entityType: "CC", principalDebtCents: R250K * 2 })],
    ["CC, under R1m, small agreement", "NCA", "JURISTIC_SMALL_AGREEMENT", input({ entityType: "CC" })],
    ["CC, unverified", "NCA", "FINANCIALS_UNPROVEN", input({ entityType: "CC", financialsVerified: false })],
    ["partnership, over R1m", "NON_NCA", "JURISTIC_OVER_THRESHOLD", input({ entityType: "PARTNERSHIP", annualTurnoverCents: R1M * 2 })],
    ["partnership, under R1m, large agreement", "NON_NCA", "LARGE_AGREEMENT", input({ entityType: "PARTNERSHIP", principalDebtCents: R250K })],
    ["partnership, under R1m, small agreement", "NCA", "JURISTIC_SMALL_AGREEMENT", input({ entityType: "PARTNERSHIP" })],
    ["partnership, no evidence", "NCA", "FINANCIALS_UNPROVEN", input({ entityType: "PARTNERSHIP", financialsEvidenceIds: [] })],
    ["company with stray natural trustees is not a trust", "NON_NCA", "JURISTIC_OVER_THRESHOLD", input({ trustees: [natural], annualTurnoverCents: R1M })],
  ])("%s → %s / %s", (_name, regime, rule, given) => {
    const result = classifyNcaRegime(given)
    expect(result.regime).toBe(regime)
    expect(result.rule).toBe(rule)
    expect(result.reason.length).toBeGreaterThan(0)
    expect(result.inputs).toEqual(given)
  })

  it.each<[string, NcaClassifierInput, string[]]>([
    ["trust, few natural trustees cites the Letters of Authority", trust({ trustees: [natural] }), ["doc_test_loa_1"]],
    ["juristic trust cites Letters of Authority and financials", trust({ trustees: [juristic] }), ["doc_test_loa_1", "doc_test_afs_1"]],
    ["company cites its financials", input({ financialsEvidenceIds: ["doc_test_afs_1", "doc_test_mgmt_1"] }), ["doc_test_afs_1", "doc_test_mgmt_1"]],
    ["company ignores trustee evidence", input({ trusteeEvidenceIds: ["doc_test_loa_9"] }), ["doc_test_afs_1"]],
  ])("evidence: %s", (_name, given, evidenceIds) => {
    expect(classifyNcaRegime(given).evidenceIds).toEqual(evidenceIds)
  })

  it("explains the trust rule in plain English", () => {
    expect(classifyNcaRegime(trust({ trustees: [natural, natural] })).reason).toBe(
      "Trust with 2 trustees, all natural persons: the NCA applies (s1, definition of \"juristic person\").",
    )
  })

  it("snapshots the inputs rather than aliasing the caller's arrays", () => {
    const given = trust({ trustees: [natural, natural, natural] })
    const result = classifyNcaRegime(given)
    given.trustees.push(juristic)
    given.financialsEvidenceIds.push("doc_test_afs_2")
    expect(result.inputs.trustees).toHaveLength(3)
    expect(result.inputs.financialsEvidenceIds).toEqual(["doc_test_afs_1"])
  })

  it.each<[string, Partial<NcaClassifierInput>]>([
    ["negative principal", { principalDebtCents: -1 }],
    ["fractional principal", { principalDebtCents: 100.5 }],
    ["NaN principal", { principalDebtCents: Number.NaN }],
    ["negative turnover", { annualTurnoverCents: -100 }],
    ["fractional turnover", { annualTurnoverCents: 0.1 }],
    ["infinite assets", { totalAssetValueCents: Number.POSITIVE_INFINITY }],
    ["negative assets", { totalAssetValueCents: -5 }],
  ])("throws RangeError on %s", (_name, overrides) => {
    expect(() => classifyNcaRegime(input(overrides))).toThrow(RangeError)
  })

  it("validates before the trust early exits", () => {
    expect(() => classifyNcaRegime(trust({ trusteeEvidenceIds: [], principalDebtCents: -1 }))).toThrow(RangeError)
  })
})
