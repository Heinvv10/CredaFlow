import { beforeEach, describe, expect, it, vi } from "vitest"

const priced = vi.hoisted(() => ({ value: null as unknown }))
const priceApplication = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => priced.value))
vi.mock("./resolve", () => ({ priceApplication }))
// The one gate activation runs (versionNcaIssues: structure, fee, cap and the MICRO30 contract): approval must run the same.
const versionNcaIssues = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as string[]))
vi.mock("./nca", () => ({ versionNcaIssues }))

import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { approvalTermsFor, capApplicationFor, previewCalcInput, versionLimitRefusal, type ProductPricing } from "./approval-terms"

const product: ProductPricing = { interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.15, initiationFeeMax: 105_000, monthlyServiceFee: 6_900 }
const application = { id: "a1", productId: "p1", appliedTermDays: 84, riskGradeRank: 0 }
const db = {} as never
const version = (over: Record<string, unknown> = {}) => ({
  id: "pv1", productId: "p1", version: 3, effectiveFrom: "2027-01-01",
  config: { minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 28, maxTermDays: 180, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeeMaxCents: 90_000, monthlyServiceFeeCents: 5_000, interestRatePm: 0.035, initiationFeePct: 0.1, repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 } }, ...over,
})

beforeEach(() => { priced.value = null; priceApplication.mockClear(); versionNcaIssues.mockReset().mockResolvedValue([]); resetActiveJurisdiction() })

describe("approvalTermsFor", () => {
  it("a product with no version in effect is approved on its own row, exactly as before: nothing versioned, no structure", async () => {
    expect(await approvalTermsFor(db, "t", application, product)).toEqual({ ...product, repayment: null, versioned: null, limits: null, ncaIssues: [] })
  })

  it("a product under the engine is approved on the version in effect, the price its rule gives and the structure for the term", async () => {
    priced.value = {
      version: version(), base: { ratePm: 0.035, initiationFeePct: 0.1 }, inputs: { segment: "SALARIED", channel: null, campaignCode: null, riskRank: 0 },
      pricing: { ratePm: 0.02, initiationFeePct: 0.08, ruleId: "r1", ruleName: "Best grades" },
      repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 12 },
    }
    expect(await approvalTermsFor(db, "t", application, product)).toEqual({
      interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.08, initiationFeeMax: 90_000, monthlyServiceFee: 5_000,
      repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 12 },
      versioned: { productVersionId: "pv1", version: 3, baseRatePm: 0.035, pricingRuleId: "r1", pricingRuleName: "Best grades", pricingInputs: { segment: "SALARIED", channel: null, campaignCode: null, riskRank: 0 } },
      limits: { minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 28, maxTermDays: 180 },
      ncaIssues: [],
    })
  })

  it("a version that keeps the product's existing behaviour carries the version but no structure", async () => {
    priced.value = { version: version(), base: { ratePm: 0.035, initiationFeePct: 0.1 }, inputs: { segment: null, channel: null, campaignCode: null, riskRank: null }, pricing: { ratePm: 0.035, initiationFeePct: 0.1, ruleId: null, ruleName: null }, repayment: null }
    const terms = await approvalTermsFor(db, "t", application, product)
    expect(terms.repayment).toBeNull()
    expect(terms.versioned).toMatchObject({ productVersionId: "pv1", pricingRuleId: null })
  })
})

describe("what an NCA lender may still approve on a version", () => {
  const priceWith = (config: Record<string, unknown> = {}) => {
    priced.value = { version: version({ config: { ...version().config, ...config } }), base: { ratePm: 0.035, initiationFeePct: 0.1 }, inputs: { segment: null, channel: null, campaignCode: null, riskRank: null }, pricing: { ratePm: 0.035, initiationFeePct: 0.1, ruleId: null, ruleName: null }, repayment: null }
  }

  it("runs the same gate as activation, on the version's configuration and the product's identity: structure, fee, cap and the MICRO30 contract", async () => {
    priceWith()
    versionNcaIssues.mockResolvedValue(["repayment: needs legal sign-off", "monthlyServiceFeeCents: above the ceiling"])
    const terms = await approvalTermsFor(db, "t", application, { ...product, code: "MICRO30", productType: "MICRO" })
    expect(terms.ncaIssues).toEqual(["repayment: needs legal sign-off", "monthlyServiceFeeCents: above the ceiling"])
    expect(versionNcaIssues).toHaveBeenCalledWith("t", { code: "MICRO30", productType: "MICRO" }, expect.objectContaining({ minAmountCents: 100_000, monthlyServiceFeeCents: 5_000 }))
  })

  it("has no issues when the gate has none, and asks no gate of a product with no version", async () => {
    priceWith()
    expect((await approvalTermsFor(db, "t", application, product)).ncaIssues).toEqual([])
    priced.value = null
    expect((await approvalTermsFor(db, "t", application, product)).ncaIssues).toEqual([])
    expect(versionNcaIssues).toHaveBeenCalledTimes(1)
  })

  it("asks for no pricing rule on the MICRO30 contract product, however its code is written: its price is fixed", async () => {
    for (const code of ["MICRO30", "micro30", " Micro30 "]) {
      await approvalTermsFor(db, "t", application, { ...product, code })
      expect(priceApplication).toHaveBeenLastCalledWith(db, "t", expect.objectContaining({ useRules: false }))
    }
    await approvalTermsFor(db, "t", application, { ...product, code: "PERSONAL" })
    expect(priceApplication).toHaveBeenLastCalledWith(db, "t", expect.objectContaining({ useRules: true }))
  })
})

describe("versionLimitRefusal", () => {
  const termsFor = async (repayment: unknown = null) => {
    priced.value = { version: version(), base: { ratePm: 0.035, initiationFeePct: 0.1 }, inputs: { segment: null, channel: null, campaignCode: null, riskRank: null }, pricing: { ratePm: 0.035, initiationFeePct: 0.1, ruleId: null, ruleName: null }, repayment }
    return approvalTermsFor(db, "t", application, product)
  }

  it("refuses an amount or a term outside the version's limits, and passes one inside", async () => {
    const terms = await termsFor()
    expect(versionLimitRefusal(terms, { principalCents: 300_000, termDays: 90 })).toBeNull()
    expect(versionLimitRefusal(terms, { principalCents: 99_999, termDays: 90 })).toContain("amount")
    expect(versionLimitRefusal(terms, { principalCents: 800_001, termDays: 90 })).toContain("amount")
    expect(versionLimitRefusal(terms, { principalCents: 300_000, termDays: 27 })).toContain("term")
    expect(versionLimitRefusal(terms, { principalCents: 300_000, termDays: 181 })).toContain("term")
  })

  it("turns a structure that cannot schedule the term into a refusal, not a thrown error", async () => {
    const terms = await termsFor({ frequency: "WEEKLY", structure: "AMORTISING", graceKind: "FULL", graceInstalments: 5, instalments: 4 })
    expect(versionLimitRefusal(terms, { principalCents: 300_000, termDays: 28 })).toContain("grace must leave")
  })
})

describe("previewCalcInput", () => {
  it("is the terms approval uses, for a staff preview: a versioned product's rate, fees and structure, not the product row's", async () => {
    priced.value = {
      version: version(), base: { ratePm: 0.035, initiationFeePct: 0.1 }, inputs: { segment: null, channel: null, campaignCode: null, riskRank: 0 },
      pricing: { ratePm: 0.02, initiationFeePct: 0.08, ruleId: "r1", ruleName: "x" }, repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 12 },
    }
    const calc = await previewCalcInput(db, "t", { ...application, appliedAmount: 300_000, initiationFeePayment: "DEFERRED" }, { ...product, productType: "PERSONAL" })
    expect(calc).toMatchObject({ principal: 300_000, interestRatePm: 0.02, initiationFeePct: 0.08, monthlyServiceFee: 5_000, productType: "PERSONAL", repayment: { frequency: "WEEKLY", instalments: 12 } })
  })

  it("is the product row's own terms for a product with no version", async () => {
    const calc = await previewCalcInput(db, "t", { ...application, appliedAmount: 300_000, initiationFeePayment: "UPFRONT" }, { ...product, productType: "PERSONAL" })
    expect(calc).toMatchObject({ interestRatePm: 0.03, initiationFeePct: 0.15, initiationFeePayment: "UPFRONT" })
    expect(calc.repayment).toBeUndefined()
  })
})

describe("capApplicationFor", () => {
  const capApplication = { appliedAmount: 500_000, appliedTermDays: 120, product: { interestRatePm: 0.02, interestModel: "FLAT" } }
  const termsOf = async (ruleId: string | null) => {
    priced.value = { version: version(), base: { ratePm: 0.035, initiationFeePct: 0.1 }, inputs: { segment: null, channel: null, campaignCode: null, riskRank: null }, pricing: { ratePm: 0.06, initiationFeePct: 0.1, ruleId, ruleName: ruleId ? "x" : null }, repayment: null }
    return approvalTermsFor(db, "t", application, product)
  }

  it("shows the cap the rate and basis the loan is written at and the principal and term it is approved for, not the product row's", async () => {
    expect(capApplicationFor(capApplication, await termsOf(null), { principalCents: 300_000, termDays: 84 })).toEqual({
      appliedAmount: 300_000, appliedTermDays: 84, product: { interestRatePm: 0.06, interestModel: "REDUCING_BALANCE" },
    })
  })

  it("does so with a pricing rule or without: the version's own rate is checked too", async () => {
    const loan = { principalCents: 300_000, termDays: 84 }
    expect(capApplicationFor(capApplication, await termsOf("r1"), loan).product.interestRatePm).toBe(0.06)
    expect(capApplicationFor(capApplication, await termsOf(null), loan).product.interestRatePm).toBe(0.06)
  })

  it("leaves the rest of the application as it was", async () => {
    const app = { ...capApplication, ncaRegime: "NON_NCA", clientId: "c1" }
    expect(capApplicationFor(app, await termsOf(null), { principalCents: 1, termDays: 1 })).toMatchObject({ ncaRegime: "NON_NCA", clientId: "c1" })
  })
})
