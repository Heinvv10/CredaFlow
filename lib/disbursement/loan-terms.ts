import type { prisma } from "@/lib/prisma"
import type { AffordabilityDecisionInputs } from "@/lib/affordability/snapshot"
import { graceDeferredInterest } from "@/lib/product-engine/schedule"

/**
 * A loan priced by the product engine keeps the version it was written on, the rule that priced it and the repayment structure it was
 * scheduled with (lib/product-engine); a later version never reaches it. Written with the loan, or not at all. Both disburse paths call this.
 */
export async function recordOriginationTerms(
  tx: Pick<typeof prisma, "loanTerms">,
  args: { tenantId: string; loanId: string; terms: AffordabilityDecisionInputs; startDate: Date },
): Promise<void> {
  const { terms, startDate } = args
  const v = terms.productVersion
  if (!v) return
  await tx.loanTerms.create({
    data: {
      loanId: args.loanId, tenantId: args.tenantId, sequence: 1, productVersionId: v.id,
      deferredInterest: terms.interestModel === "DAILY_ACCRUAL" ? 0 : graceDeferredInterest({ principalCents: terms.principalCents, interestRatePm: terms.interestRatePm, interestModel: terms.interestModel, startDate, repayment: terms.repayment }),
      frequency: terms.repayment?.frequency ?? null, structure: terms.repayment?.structure ?? null, graceKind: terms.repayment?.graceKind ?? null,
      graceInstalments: terms.repayment?.graceInstalments ?? 0, instalments: terms.repayment?.instalments ?? null,
      baseRatePm: v.baseRatePm, interestRatePm: terms.interestRatePm, pricingRuleId: v.pricingRuleId, pricingRuleName: v.pricingRuleName, pricingInputs: v.pricingInputs,
    },
  })
}
