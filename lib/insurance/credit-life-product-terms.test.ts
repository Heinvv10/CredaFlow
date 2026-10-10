import { describe, expect, it } from "vitest"
import { creditLifeProductTermsIssues } from "./credit-life-product-terms"

describe("creditLifeProductTermsIssues", () => {
  it("accepts a credit-life product with a positive premium and cover", () => {
    expect(creditLifeProductTermsIssues({ type: "CREDIT_LIFE", premiumAmount: 22.5, sumAssured: 5_000 })).toEqual([])
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses a credit-life premium of %s", (premiumAmount) => {
    expect(creditLifeProductTermsIssues({ type: "CREDIT_LIFE", premiumAmount, sumAssured: 5_000 })).toEqual(["premiumAmount"])
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses a credit-life cover of %s", (sumAssured) => {
    expect(creditLifeProductTermsIssues({ type: "CREDIT_LIFE", premiumAmount: 22.5, sumAssured })).toEqual(["sumAssured"])
  })

  it("names both fields when both are missing", () => {
    expect(creditLifeProductTermsIssues({ type: "CREDIT_LIFE", premiumAmount: 0, sumAssured: 0 }))
      .toEqual(["premiumAmount", "sumAssured"])
  })

  it("leaves other product types alone", () => {
    expect(creditLifeProductTermsIssues({ type: "FUNERAL_COVER", premiumAmount: 0, sumAssured: 0 })).toEqual([])
  })
})
