import { assessAffordability, type AffordabilityResult } from "@/lib/affordability/ndi"

/**
 * The staff affordability preview: the larger of the application's and the
 * client's declared debts, as the server recompute takes it. One function for
 * the Affordability panel and the decision rail, so the panel can never say
 * NOT AFFORDABLE while the rail says there are no blockers. All money in cents.
 */
export function previewAffordability(input: {
  monthlyIncomeCents: number
  monthlyExpensesCents: number
  applicationDebtInstalmentsCents: readonly number[]
  clientDebtTotalCents: number
  proposedInstalmentCents: number
}): AffordabilityResult {
  const applicationDebtTotal = input.applicationDebtInstalmentsCents.reduce(
    (sum, instalment) => sum + Math.max(0, Math.round(instalment || 0)),
    0,
  )
  return assessAffordability({
    monthlyIncomeCents: input.monthlyIncomeCents,
    monthlyExpensesCents: input.monthlyExpensesCents,
    debts: [{ monthlyInstalment: Math.max(applicationDebtTotal, input.clientDebtTotalCents) }],
    proposedInstalmentCents: input.proposedInstalmentCents,
  })
}
