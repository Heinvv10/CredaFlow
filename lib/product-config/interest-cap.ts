import { prisma } from "@/lib/prisma"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { NCA_CREDIT_TYPE_LABELS, productCreditType } from "@/lib/loan/nca-interest-cap"
import { checkNcaInterestRateFor } from "@/lib/loan/nca-interest-cap.server"

// The NCA interest cap on a loan product's price (lib/loan/nca-interest-cap.ts).
//
// Applied to every product, including one used only for asset-finance
// (NON_NCA) deals: a LoanProduct carries no regime — the regime belongs to each
// application, and an asset-finance product also writes NCA-regulated deals
// (a sole proprietor, a trust with few trustees). Approval skips the cap for a
// NON_NCA application; the product, which may write either, is held to it.

type Pricing = { maxAmount: number; maxTermDays: number; interestRatePm: number; interestModel: string }

/**
 * The 422 body refusing a product priced above the cap for the strictest
 * credit type it can write, or null when the rate is lawful. Values are as
 * stored: cents, days, decimal rate.
 */
export async function loanProductInterestCapRefusal(
  tenantId: string,
  product: Pricing,
): Promise<{ error: string; invalidFields: string[]; creditType: string } | null> {
  const creditType = productCreditType(product)
  const label = NCA_CREDIT_TYPE_LABELS[creditType]
  if (!Number.isFinite(product.interestRatePm) || product.interestRatePm < 0) {
    return { error: "The interest rate must be a non-negative percentage per month.", invalidFields: ["interestRatePm"], creditType: label }
  }
  // Outside the NCA there is no statutory ceiling; the sign check above is not a cap and stays.
  if (!isNcaJurisdiction()) return null
  const result = await checkNcaInterestRateFor(prisma, tenantId, { creditType, ...product })
  return result.ok ? null : { error: result.message, invalidFields: ["interestRatePm"], creditType: label }
}

/**
 * The cap on a product edit: checked only when the product is (or becomes)
 * active and its price or the loans it can write change. Deactivating a
 * product, or renaming one, must work even while it is over the cap or no
 * repo rate is recorded — that is how an over-priced product is withdrawn.
 */
export async function loanProductUpdateCapRefusal(
  tenantId: string,
  before: Pricing & { active: boolean },
  after: Pricing & { active?: boolean },
) {
  const active = after.active ?? before.active
  if (!active) return null
  const repriced = before.interestRatePm !== after.interestRatePm
    || before.interestModel !== after.interestModel
    || before.maxAmount !== after.maxAmount
    || before.maxTermDays !== after.maxTermDays
  return repriced || !before.active ? loanProductInterestCapRefusal(tenantId, after) : null
}

/** The cap on a new product: only an active one prices loans. */
export async function loanProductCreateCapRefusal(tenantId: string, product: Pricing & { active?: boolean }) {
  return product.active === false ? null : loanProductInterestCapRefusal(tenantId, product)
}
