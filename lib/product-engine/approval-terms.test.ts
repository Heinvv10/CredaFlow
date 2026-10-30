import { beforeEach, describe, expect, it, vi } from "vitest"

const priced = vi.hoisted(() => ({ value: null as unknown }))
const refusal = vi.hoisted(() => vi.fn(async () => null as string | null))
vi.mock("./resolve", () => ({ priceApplication: vi.fn(async () => priced.value) }))
vi.mock("./nca", () => ({ pricedRateRefusal: refusal }))

import { approvalTermsFor, ruledRateRefusal, type ProductPricing } from "./approval-terms"

const product: ProductPricing = { interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.15, initiationFeeMax: 105_000, monthlyServiceFee: 6_900 }
const application = { id: "a1", productId: "p1", appliedTermDays: 84, riskGradeRank: 0 }
const db = {} as never
const version = (over: Record<string, unknown> = {}) => ({
  id: "pv1", productId: "p1", version: 3, effectiveFrom: "2027-01-01",
  config: { interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeeMaxCents: 90_000, monthlyServiceFeeCents: 5_000, interestRatePm: 0.035, initiationFeePct: 0.1, repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 } }, ...over,
})

beforeEach(() => { priced.value = null; refusal.mockClear().mockResolvedValue(null) })

describe("approvalTermsFor", () => {
  it("a product with no version in effect is approved on its own row, exactly as before: nothing versioned, no structure", async () => {
    expect(await approvalTermsFor(db, "t", application, product)).toEqual({ ...product, repayment: null, versioned: null })
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
    })
  })

  it("a version that keeps the product's existing behaviour carries the version but no structure", async () => {
    priced.value = { version: version(), base: { ratePm: 0.035, initiationFeePct: 0.1 }, inputs: { segment: null, channel: null, campaignCode: null, riskRank: null }, pricing: { ratePm: 0.035, initiationFeePct: 0.1, ruleId: null, ruleName: null }, repayment: null }
    const terms = await approvalTermsFor(db, "t", application, product)
    expect(terms.repayment).toBeNull()
    expect(terms.versioned).toMatchObject({ productVersionId: "pv1", pricingRuleId: null })
  })
})

describe("ruledRateRefusal", () => {
  const terms = async (ruleId: string | null) => {
    priced.value = { version: version(), base: { ratePm: 0.035, initiationFeePct: 0.1 }, inputs: { segment: null, channel: null, campaignCode: null, riskRank: null }, pricing: { ratePm: 0.06, initiationFeePct: 0.1, ruleId, ruleName: ruleId ? "x" : null }, repayment: null }
    return approvalTermsFor(db, "t", application, product)
  }

  it("checks a rule's rate against the cap for this loan and passes on the refusal", async () => {
    refusal.mockResolvedValue("6.00% per month exceeds the NCA maximum")
    expect(await ruledRateRefusal("t", await terms("r1"), { principalCents: 300_000, termDays: 84 })).toContain("NCA maximum")
    expect(refusal).toHaveBeenCalledWith("t", { principalCents: 300_000, termDays: 84, interestRatePm: 0.06, interestModel: "REDUCING_BALANCE" })
  })

  it("does not re-check a price no rule set: the product's own rate is held to the cap when the version is approved", async () => {
    refusal.mockResolvedValue("would refuse")
    expect(await ruledRateRefusal("t", await terms(null), { principalCents: 300_000, termDays: 84 })).toBeNull()
    expect(refusal).not.toHaveBeenCalled()
  })

  it("has nothing to check for a product with no version", async () => {
    priced.value = null
    expect(await ruledRateRefusal("t", await approvalTermsFor(db, "t", application, product), { principalCents: 1, termDays: 1 })).toBeNull()
  })
})
