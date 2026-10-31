import { describe, expect, it, vi } from "vitest"

const nca = vi.hoisted(() => ({ versionNcaIssues: vi.fn(async (..._a: unknown[]) => [] as string[]), pricingRuleNcaIssue: vi.fn(async (..._a: unknown[]) => null as string | null) }))
vi.mock("./nca", () => nca)

import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { pricingRuleHandler, productVersionHandler, parseProductVersionPayload } from "./change-handlers"

const config = {
  minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.05,
  initiationFeeMaxCents: 100_000, monthlyServiceFeeCents: 6_900, repayment: null, collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null },
}
const problems = (raw: unknown) => {
  try {
    parseProductVersionPayload(raw)
    return []
  } catch (e) {
    return (e as InvalidPayloadError).problems
  }
}

describe("parseProductVersionPayload", () => {
  it("accepts a version and trims the reason", () => {
    expect(parseProductVersionPayload({ productId: "p1", effectiveFrom: "2027-04-01", reason: "  Quarterly repricing  ", config }).reason).toBe("Quarterly repricing")
  })

  it("names every problem with its path, the configuration's under payload.config", () => {
    const found = problems({ productId: "", effectiveFrom: "1 April", reason: "no", config: { ...config, interestRatePm: 2, minAmountCents: -1 } })
    expect(found.some((p) => p.startsWith("payload.productId"))).toBe(true)
    expect(found.some((p) => p.startsWith("payload.effectiveFrom"))).toBe(true)
    expect(found.some((p) => p.startsWith("payload.reason"))).toBe(true)
    expect(found.some((p) => p.startsWith("payload.config.interestRatePm"))).toBe(true)
    expect(found.some((p) => p.startsWith("payload.config.minAmountCents"))).toBe(true)
  })

  it("refuses unknown keys and a missing configuration", () => {
    expect(problems({ productId: "p1", effectiveFrom: "2027-04-01", reason: "Repricing", config, extra: 1 }).length).toBeGreaterThan(0)
    expect(problems({ productId: "p1", effectiveFrom: "2027-04-01", reason: "Repricing" }).length).toBeGreaterThan(0)
  })
})

describe("the handlers", () => {
  it("are maker-checker kinds with the permissions the registry names: a loan administrator drafts, an administrator approves", () => {
    expect(productVersionHandler).toMatchObject({ kind: "PRODUCT_VERSION", makePermission: "manage_product_versions", approvePermission: "approve_product_versions" })
    expect(pricingRuleHandler).toMatchObject({ kind: "PRODUCT_PRICING_RULE", makePermission: "manage_product_versions", approvePermission: "approve_product_versions" })
  })

  it("only a version is drafted against the latest one: a rule is independent", () => {
    expect(typeof productVersionHandler.baseRef).toBe("function")
    expect(pricingRuleHandler.baseRef).toBeUndefined()
  })
})

// verify() runs when a request is submitted and again when it is approved: it is where the NCA rules bind a version and a rule.
describe("the handlers' verify", () => {
  const payload = { productId: "p1", effectiveFrom: "2027-04-01", reason: "Quarterly repricing", config: parseProductVersionPayload({ productId: "p1", effectiveFrom: "2027-04-01", reason: "Quarterly repricing", config }).config }
  const tx = (over: { product?: Record<string, unknown> | null; taken?: Record<string, unknown> | null; products?: Array<Record<string, unknown>>; versions?: Array<Record<string, unknown>> } = {}) => ({
    loanProduct: {
      findFirst: vi.fn(async () => (over.product === undefined ? { id: "p1", code: "PERS", productType: "PERSONAL" } : over.product)),
      findMany: vi.fn(async () => over.products ?? [{ id: "p1", code: "PERS", productType: "PERSONAL", maxAmount: 800_000, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" }]),
    },
    productVersion: { findFirst: vi.fn(async () => over.taken ?? null), findMany: vi.fn(async () => over.versions ?? []) },
    productPricingRule: { findFirst: vi.fn(async () => null) },
  }) as never

  const handlers = async () => ({ productVersionHandler, pricingRuleHandler })

  it("refuses a version an NCA lender may not use, naming each issue under payload.config", async () => {
    nca.versionNcaIssues.mockResolvedValueOnce(["repayment: needs legal sign-off", "interestRatePm: above the cap"])
    const { productVersionHandler: handler } = await handlers()
    await expect(handler.verify!(tx(), "t1", payload as never)).rejects.toMatchObject({ code: "INVALID_PAYLOAD", problems: ["payload.config.repayment: needs legal sign-off", "payload.config.interestRatePm: above the cap"] })
  })

  it("refuses a product that does not exist, an asset-finance product, and a day another version already takes", async () => {
    const { productVersionHandler: handler } = await handlers()
    await expect(handler.verify!(tx({ product: null }), "t1", payload as never)).rejects.toMatchObject({ problems: [expect.stringContaining("does not exist")] })
    await expect(handler.verify!(tx({ product: { id: "p1", code: "AF", productType: "ASSET_FINANCE" } }), "t1", payload as never)).rejects.toMatchObject({ problems: [expect.stringContaining("asset-finance")] })
    await expect(handler.verify!(tx({ taken: { version: 2 } }), "t1", payload as never)).rejects.toMatchObject({ problems: [expect.stringContaining("version 2 already takes effect")] })
  })

  it("passes a version with no issues", async () => {
    const { productVersionHandler: handler } = await handlers()
    await expect(handler.verify!(tx(), "t1", payload as never)).resolves.toBeUndefined()
  })

  it("checks a pricing rule against the rate of the version in effect and every scheduled one, not the product row's", async () => {
    const { pricingRuleHandler: handler } = await handlers()
    const rule = { action: "CREATE", rule: { productId: "p1", name: "Best", segment: null, channel: null, riskRankMin: null, riskRankMax: null, campaignCode: null, validFrom: "2027-01-01", validTo: null, priority: 0, rate: { mode: "ADD", value: 0.005 }, initiationFeePct: null } }
    const past = new Date("2000-01-01T00:00:00Z")
    const future = new Date("2999-01-01T00:00:00Z")
    const versions = [{ productId: "p1", version: 1, effectiveFrom: past, maxAmount: 700_000, maxTermDays: 90, interestRatePm: 0.01, interestModel: "REDUCING_BALANCE" }, { productId: "p1", version: 2, effectiveFrom: past, maxAmount: 700_000, maxTermDays: 90, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE" }, { productId: "p1", version: 3, effectiveFrom: future, maxAmount: 800_000, maxTermDays: 120, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE" }]
    await handler.verify!(tx({ versions }), "t1", rule as never)
    // v1 is superseded; v2 is in effect and v3 is scheduled; the product row's own 3% is not what is checked
    expect(nca.pricingRuleNcaIssue).toHaveBeenLastCalledWith("t1", rule.rule.rate, [
      expect.objectContaining({ code: "PERS v2", interestRatePm: 0.02, maxAmount: 700_000 }),
      expect.objectContaining({ code: "PERS v3", interestRatePm: 0.04, maxTermDays: 120 }),
    ])
  })

  it("takes MICRO30 however its code is written: a rule naming it is refused, and a rule for every product leaves it out", async () => {
    const { pricingRuleHandler: handler } = await handlers()
    const rule = (productId: string | null) => ({ action: "CREATE", rule: { productId, name: "Best", segment: null, channel: null, riskRankMin: null, riskRankMax: null, campaignCode: null, validFrom: "2027-01-01", validTo: null, priority: 0, rate: { mode: "SET", value: 0.02 }, initiationFeePct: null } })
    const micro = (code: string) => ({ id: "m1", code, productType: "MICRO", maxAmount: 200_000, maxTermDays: 30, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL" })
    for (const code of ["micro30", " Micro30 "]) {
      await expect(handler.verify!(tx({ products: [micro(code)] }), "t1", rule("m1") as never)).rejects.toMatchObject({ problems: [expect.stringContaining("MICRO30")] })
    }
    nca.pricingRuleNcaIssue.mockClear()
    await handler.verify!(tx({ products: [micro(" micro30 "), { id: "p1", code: "PERS", productType: "PERSONAL", maxAmount: 800_000, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" }] }), "t1", rule(null) as never)
    expect(nca.pricingRuleNcaIssue).toHaveBeenLastCalledWith("t1", expect.anything(), [expect.objectContaining({ code: "PERS" })])
  })

  it("refuses a rule that names the MICRO30 contract product, and leaves it out of a rule that covers every product", async () => {
    const { pricingRuleHandler: handler } = await handlers()
    const rule = (productId: string | null) => ({ action: "CREATE", rule: { productId, name: "Best", segment: null, channel: null, riskRankMin: null, riskRankMax: null, campaignCode: null, validFrom: "2027-01-01", validTo: null, priority: 0, rate: { mode: "SET", value: 0.02 }, initiationFeePct: null } })
    const micro = { id: "m1", code: "MICRO30", productType: "MICRO", maxAmount: 200_000, maxTermDays: 30, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL" }
    await expect(handler.verify!(tx({ products: [micro] }), "t1", rule("m1") as never)).rejects.toMatchObject({ problems: [expect.stringContaining("MICRO30")] })
  })
})
