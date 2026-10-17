import { checkNcaInterestRate, ncaCreditType, NCA_CREDIT_TYPE_LABELS } from "@/lib/loan/nca-interest-cap"
import { repoRateIsPlausible } from "@/lib/asset-finance/reference-rate-input"

export interface InterestGuidanceBasis {
  day: string
  repo: { rate: number; approved: number } | null
}

/** An illustrative transaction, using approval's classification and rate check. Never a product-wide certification. */
export function interestGuidance(input: { productType: string; amountRand: number; termDays: number; ratePercentPm: number; interestModel: string }, basis?: InterestGuidanceBasis) {
  if (input.productType === "ASSET_FINANCE") return { warning: false, message: "Rate checked per asset-finance deal and its recorded regime.", classification: null }
  if (!Number.isFinite(input.amountRand) || input.amountRand <= 0 || !Number.isFinite(input.termDays) || input.termDays <= 0) {
    return { warning: true, message: "Enter a preview amount and term to check the transaction's interest rate.", classification: null }
  }
  const creditType = ncaCreditType(Math.round(input.amountRand * 100), input.termDays)
  if (creditType === "UNSECURED" && basis?.repo && !repoRateIsPlausible(basis.repo.approved)) {
    return { warning: true, message: "The approved repo rate is outside the supported plausible band; approval requires a corrected repo record.", classification: NCA_CREDIT_TYPE_LABELS[creditType] }
  }
  const result = checkNcaInterestRate({ creditType, interestRatePm: input.ratePercentPm / 100, interestModel: input.interestModel, repoAnnualRate: basis?.repo?.rate ?? null })
  return { warning: !result.ok, message: result.ok ? "Preview rate passes the base interest check for this transaction." : result.message, classification: NCA_CREDIT_TYPE_LABELS[creditType] }
}
