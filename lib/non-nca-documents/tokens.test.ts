import { describe, expect, it } from "vitest"
import { TOKEN_REGISTRY, renderTokens, type TokenContext } from "@/lib/documents/tokens"
import { quoteFor } from "./quote"
import { approvedAffordabilityResult } from "./approval.integration-fixture"

const base = { tenant: {}, lender: null, client: { firstName: "A", lastName: "B" } } as unknown as TokenContext

describe("the quote.* tokens", () => {
  const quoteTokens = TOKEN_REGISTRY.filter((t) => t.token.startsWith("quote."))

  it("resolve to nothing without a quote, so a document that needs one refuses to print", () => {
    expect(quoteTokens.length).toBeGreaterThanOrEqual(10)
    for (const t of quoteTokens) expect(t.resolve(base), t.token).toBeNull()
    expect(renderTokens("{{quote.principal}}", base).missing).toEqual(["quote.principal"])
  })

  it("resolve every figure from the approved terms", () => {
    const quote = quoteFor({
      affordabilityResult: approvedAffordabilityResult({ principalCents: 500_000, termDays: 90, productId: "p", interestRatePm: 0.023, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 6_900 }),
      repaymentMethod: "EFT",
    })
    for (const t of quoteTokens) expect(t.resolve({ ...base, quote }), t.token).toBeTruthy()
    expect(renderTokens("{{quote.interestRate}} / {{quote.repaymentMethod}}", { ...base, quote }).html).toBe("2.30% per month / EFT")
  })
})
