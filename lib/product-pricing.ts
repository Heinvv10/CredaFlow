// SINGLE SOURCE OF TRUTH for public-facing loan pricing.
//
// These figures MUST mirror the active LoanProduct rows in the database —
// the same config read by app/api/applications/[id]/affordability — so the
// marketing quote equals the loan the customer is actually charged.
//
// Before this module, several separate hardcoded copies of a stale fee table
// (15% init / R1,207.50 cap / R69 service) had drifted from the live products
// and were UNDER-quoting some loans (e.g. a R5,000 personal loan was shown as
// R750 initiation when the product charges R825). Every live quote/disclosure
// surface now reads from here.
//
// NCA note: the personal-loan initiation fee (16.5%) is under separate legal
// review. This module reflects what the product CURRENTLY charges;
// it does NOT set or change that fee. When the LoanProduct config changes
// (legal-gated), update this snapshot in the same change so the two stay in
// lockstep.

export type PublicPricingCode =
  | "short-term"
  | "personal"
  | "purchase-order"
  | "invoice-discounting"

export type ProductPricing = {
  /** NCA initiation-fee regime — see lib/loan/nca-fee-cap.ts. */
  productType: string
  interestRatePm: number // e.g. 0.05 = 5% per month
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  /**
   * How the fee is PRICED. NCA_REG42 prices on the statutory schedule, so the
   * published figure and the charged figure are the same number; FLAT_PCT
   * prices on `initiationFeePct`. See LoanProduct.initiationFeeModel.
   */
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMax: number // cents, 0 = uncapped
  monthlyServiceFee: number // cents per month
}

// Keyed by public product code. Each entry mirrors the corresponding
// LoanProduct row.
export const PRODUCT_PRICING: Record<PublicPricingCode, ProductPricing> = {
  // "30-Day Micro Loan" (MICRO30) — 15% init capped at R1,000, R69 service
  // (R60 + VAT, the NCA-prescribed max), 5%/month. The service fee is charged
  // once on the 30-day term. DAILY_ACCRUAL produces the disclosed maturity
  // quote at origination and the servicing layer rebates interest that has not
  // accrued when the borrower settles before day 30.
  "short-term": {
    productType: "MICRO",
    interestRatePm: 0.05,
    interestModel: "DAILY_ACCRUAL",
    initiationFeeModel: "NCA_REG42",
    initiationFeePct: 0.15,
    initiationFeeMax: 100000,
    monthlyServiceFee: 6900,
  },
  // "Personal Loan" — 16.5% init capped at R1,080,
  // R69 service, 3%/month reducing balance.
  personal: {
    productType: "PERSONAL",
    interestRatePm: 0.03,
    interestModel: "REDUCING_BALANCE",
    initiationFeeModel: "NCA_REG42",
    initiationFeePct: 0.165,
    initiationFeeMax: 108000,
    monthlyServiceFee: 6900,
  },
  // "Purchase Order Funding" — 2% init (uncapped), no service, 5%/month
  // daily accrual to maturity.
  "purchase-order": {
    productType: "PO_FUNDING",
    interestRatePm: 0.05,
    interestModel: "DAILY_ACCRUAL",
    initiationFeeModel: "FLAT_PCT",
    initiationFeePct: 0.02,
    initiationFeeMax: 0,
    monthlyServiceFee: 0,
  },
  // Invoice discounting has NO live LoanProduct: the quote is indicative only
  // and the apply flow routes it to an advisor enquiry. Priced to match
  // its nearest real product (PO funding) so the estimate is not misleading.
  "invoice-discounting": {
    productType: "PO_FUNDING",
    interestRatePm: 0.05,
    interestModel: "DAILY_ACCRUAL",
    initiationFeeModel: "FLAT_PCT",
    initiationFeePct: 0.02,
    initiationFeeMax: 0,
    monthlyServiceFee: 0,
  },
}
