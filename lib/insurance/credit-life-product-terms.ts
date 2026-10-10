// A credit-life product can only back a new sale with a premium and cover
// above zero: the bundled-policy guard (assertBundledCreditLifePolicyTerms)
// refuses a policy against any other. Checked on the values the product API
// writes, so such a product is refused when saved, not at disbursement.
export function creditLifeProductTermsIssues(product: {
  type: unknown
  premiumAmount: number
  sumAssured: number
}): string[] {
  if (product.type !== "CREDIT_LIFE") return []
  const positive = (value: number) => Number.isFinite(value) && value > 0
  const issues: string[] = []
  if (!positive(product.premiumAmount)) issues.push("premiumAmount")
  if (!positive(product.sumAssured)) issues.push("sumAssured")
  return issues
}

export const CREDIT_LIFE_PRODUCT_TERMS_ERROR =
  "A credit-life product needs a premium and a sum assured above zero."
