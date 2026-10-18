import { addVat, splitInclusive } from "@/lib/vat/amounts"
import { assessReasonableCancellation } from "./cpa-cancellation-assessment"

export interface LessorFinancialInputs {
  pvExclVatCents: number
  undiscountedRentalsCents: number
  netProceedsCents: number
  chargedCosts: Array<{ id: string; grossCents: number }>
  vatRateTenThousandths: number
}

/** Contract 9.10/CPA s48: staff approve a final net charge, separately from arrears.
 * Reg5's factors inform the assessment; its consumer-cancellation purpose is not
 * asserted to be the statutory purpose of a lessor's breach cancellation.
 */
export function assessLessorCancellation(input: LessorFinancialInputs, value: unknown) {
  for (const amount of [input.pvExclVatCents, input.undiscountedRentalsCents, input.netProceedsCents, ...input.chargedCosts.map((c) => c.grossCents)]) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("Exact non-negative cancellation amounts required")
  }
  const actualCostsCents = input.chargedCosts.reduce((sum, cost) => sum + cost.grossCents, 0)
  const pvGross = addVat(input.pvExclVatCents, input.vatRateTenThousandths).inclVatCents
  const ceilingCents = Math.max(0, Math.min(pvGross + actualCostsCents - input.netProceedsCents, input.undiscountedRentalsCents - 1))
  if (!value || typeof value !== "object") throw new RangeError("A case-specific lessor cancellation assessment is required")
  const raw = value as { fairnessReason?: unknown }
  if (typeof raw.fairnessReason !== "string" || !raw.fairnessReason.trim()) throw new RangeError("Explain why this breach-cancellation charge is fair and proportionate under CPA s48 and clause 9.10")
  const common = assessReasonableCancellation({ ...value, cancellationRightReason: raw.fairnessReason }, ceilingCents)
  const assessment = { assessedChargeCents: common.assessedChargeCents, ceilingCents: common.ceilingCents, factors: common.factors, rationale: common.rationale }
  // A concession changes the customer's obligation, never the vendor expense or cash.
  const damagesInclVatCents = Math.min(pvGross, input.netProceedsCents + assessment.assessedChargeCents)
  const chargedCostsCents = Math.min(actualCostsCents, Math.max(0, input.netProceedsCents + assessment.assessedChargeCents - damagesInclVatCents))
  const costConcessionCents = actualCostsCents - chargedCostsCents
  let budget = chargedCostsCents
  const costAllocations = [...input.chargedCosts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((cost) => {
    const collectibleCents = Math.min(cost.grossCents, budget)
    budget -= collectibleCents
    return { id: cost.id, actualCents: cost.grossCents, collectibleCents }
  })
  return { ...assessment, context: "lessor_breach_cpa48_contract9_10", fairnessReason: raw.fairnessReason.trim(),
    pvExclVatCents: input.pvExclVatCents, undiscountedRentalsCents: input.undiscountedRentalsCents,
    netProceedsCents: input.netProceedsCents, actualCostsCents, chargedCostsCents, costConcessionCents, costAllocations,
    damagesInclVatCents, damagesExclVatCents: splitInclusive(damagesInclVatCents, input.vatRateTenThousandths).exclVatCents,
    vatRateTenThousandths: input.vatRateTenThousandths }
}
