import { describe, expect, it } from "vitest"
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
