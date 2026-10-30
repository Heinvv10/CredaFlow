import { describe, expect, it } from "vitest"
import { approvedAffordabilityResult } from "./approval.integration-fixture"
import { QuoteUnavailableError, quoteFor } from "./quote"

const terms = { principalCents: 500_000, termDays: 90, productId: "p-1", interestRatePm: 0.023, interestModel: "REDUCING_BALANCE" as const, monthlyServiceFeeCents: 6_900 }

describe("quoteFor", () => {
  it("prices the application from its frozen approval, with the schedule the loan will run on", () => {
    const quote = quoteFor({ affordabilityResult: approvedAffordabilityResult(terms), repaymentMethod: "EFT" })
    expect(quote).toMatchObject({ principalCents: 500_000, termDays: 90, interestRatePm: 0.023, repaymentMethod: "EFT" })
    expect(quote.instalments).toBeGreaterThan(0)
    expect(quote.totalRepayableCents).toBeGreaterThan(quote.principalCents)
    expect(quote.lastDueDate.getTime()).toBeGreaterThanOrEqual(quote.firstDueDate.getTime())
  })

  it("is not a re-pricing from the product: the figures are those the approval carries", () => {
    const a = quoteFor({ affordabilityResult: approvedAffordabilityResult(terms), repaymentMethod: "EFT" })
    const b = quoteFor({ affordabilityResult: approvedAffordabilityResult({ ...terms, interestRatePm: 0.03 }), repaymentMethod: "EFT" })
    expect(b.totalInterestCents).toBeGreaterThan(a.totalInterestCents)
  })

  it("refuses an application with no approval, and one whose approval was tampered with", () => {
    expect(() => quoteFor({ affordabilityResult: null, repaymentMethod: "EFT" })).toThrow(QuoteUnavailableError)
    const result = JSON.parse(JSON.stringify(approvedAffordabilityResult(terms))) as { approval: { inputs: { interestRatePm: number } } }
    result.approval.inputs.interestRatePm = 0.001
    expect(() => quoteFor({ affordabilityResult: result, repaymentMethod: "EFT" })).toThrow(/no intact approval/)
  })
})
