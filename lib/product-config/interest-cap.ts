import { prisma } from "@/lib/prisma"
import { NCA_CREDIT_TYPE_LABELS, productCreditType } from "@/lib/loan/nca-interest-cap"
import { checkNcaInterestRateFor } from "@/lib/loan/nca-interest-cap.server"

/**
 * The 422 body refusing a loan product priced above the NCA interest cap
 * (lib/loan/nca-interest-cap.ts) for the strictest credit type it can write,
 * or null when the rate is lawful. Values are as stored: cents, days, decimal rate.
 */
export async function loanProductInterestCapRefusal(
  tenantId: string,
  product: { maxAmount: number; maxTermDays: number; interestRatePm: number; interestModel: string },
): Promise<{ error: string; invalidFields: string[]; creditType: string } | null> {
  const creditType = productCreditType(product)
  const label = NCA_CREDIT_TYPE_LABELS[creditType]
  if (!Number.isFinite(product.interestRatePm) || product.interestRatePm < 0) {
    return { error: "The interest rate must be a non-negative percentage per month.", invalidFields: ["interestRatePm"], creditType: label }
  }
  const result = await checkNcaInterestRateFor(prisma, tenantId, { creditType, ...product })
  return result.ok ? null : { error: result.message, invalidFields: ["interestRatePm"], creditType: label }
}
