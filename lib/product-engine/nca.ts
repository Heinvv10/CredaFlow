/**
 * What a version or a price must satisfy for an NCA lender, beyond the structure rules in terms.ts: the interest ceiling
 * (which reads the lender's approved repo rate), the Micro Loan contract, and the rate a rule actually prices a loan at.
 * Outside the NCA jurisdiction none of it applies; the sign checks of the parsers stand.
 */
import { prisma } from "@/lib/prisma"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { ncaCreditType } from "@/lib/loan/nca-interest-cap"
import { checkNcaInterestRateFor } from "@/lib/loan/nca-interest-cap.server"
import { loanProductInterestCapRefusal } from "@/lib/product-config/interest-cap"
import { micro30ContractIssues } from "@/lib/product-config/micro30"
import { ncaStructureIssues, type ProductConfig } from "./terms"

export interface ProductIdentity {
  code: string
  productType: string
}

/** Every reason an NCA lender may not approve this configuration, one line each; empty outside the NCA. */
export async function versionNcaIssues(tenantId: string, product: ProductIdentity, config: ProductConfig): Promise<string[]> {
  if (!isNcaJurisdiction()) return []
  const issues = ncaStructureIssues(config)
  const cap = await loanProductInterestCapRefusal(tenantId, { maxAmount: config.maxAmountCents, maxTermDays: config.maxTermDays, interestRatePm: config.interestRatePm, interestModel: config.interestModel })
  if (cap) issues.push(`interestRatePm: ${cap.error}`)
  const micro = micro30ContractIssues({
    code: product.code, productType: product.productType, minAmount: config.minAmountCents, maxAmount: config.maxAmountCents, minTermDays: config.minTermDays,
    maxTermDays: config.maxTermDays, interestRatePm: config.interestRatePm, interestModel: config.interestModel, monthlyServiceFee: config.monthlyServiceFeeCents,
    initiationFeeModel: config.initiationFeeModel, initiationFeePct: config.initiationFeePct, initiationFeeMax: config.initiationFeeMaxCents,
  })
  for (const field of micro) issues.push(`${field}: the MICRO30 product has an approved fixed contract`)
  return issues
}

/**
 * The reason a rule would price a product above the NCA ceiling, or null: checked for the rate the rule gives each product it
 * covers, at that product's strictest credit type. `products` are the active products in the rule's scope.
 */
export async function pricingRuleNcaIssue(
  tenantId: string,
  rate: { mode: "SET" | "ADD"; value: number },
  products: ReadonlyArray<{ code: string; maxAmount: number; maxTermDays: number; interestRatePm: number; interestModel: string }>,
): Promise<string | null> {
  if (!isNcaJurisdiction()) return null
  for (const product of products) {
    const ratePm = rate.mode === "SET" ? rate.value : Math.max(0, product.interestRatePm + rate.value)
    const refusal = await loanProductInterestCapRefusal(tenantId, { maxAmount: product.maxAmount, maxTermDays: product.maxTermDays, interestRatePm: ratePm, interestModel: product.interestModel })
    if (refusal) return `rate: ${product.code}: ${refusal.error}`
  }
  return null
}

/** The refusal when a loan of this principal and term may not be priced at `interestRatePm`, or null. Never re-prices: it refuses. */
export async function pricedRateRefusal(tenantId: string, loan: { principalCents: number; termDays: number; interestRatePm: number; interestModel: string }): Promise<string | null> {
  if (!isNcaJurisdiction()) return null
  const result = await checkNcaInterestRateFor(prisma, tenantId, { creditType: ncaCreditType(loan.principalCents, loan.termDays), interestRatePm: loan.interestRatePm, interestModel: loan.interestModel })
  return result.ok ? null : result.message
}
