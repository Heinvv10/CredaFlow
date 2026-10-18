/** CPA Regulations 5(2)(a)–(j). Notes may explain why a factor is inapplicable. */
export const CPA_CANCELLATION_FACTORS = [
  ["amountOwed", "Amounts owed up to cancellation"],
  ["transactionValue", "Value of the transaction up to cancellation"],
  ["retainedGoods", "Value of goods retained by the consumer"],
  ["returnedGoods", "Value of goods returned to the lessor"],
  ["originalDuration", "Originally agreed duration"],
  ["consumerLossesBenefits", "Consumer losses or benefits from the agreement"],
  ["natureOfGoods", "Nature of the goods or services"],
  ["noticeLength", "Length of cancellation notice"],
  ["alternativeConsumer", "Diligent opportunity to find an alternative consumer"],
  ["industryPractice", "Relevant industry practice"],
] as const

type Factor = typeof CPA_CANCELLATION_FACTORS[number][0]
export interface ReasonableCancellationAssessment {
  assessedChargeCents: number
  factors: Record<Factor, string>
  rationale: string
  cancellationRightReason: string
}

/** The financial formula is a ceiling, never an automatic finding of reasonableness. */
export function assessReasonableCancellation(value: unknown, ceilingCents: number): ReasonableCancellationAssessment & { ceilingCents: number } {
  if (!value || typeof value !== "object") throw new RangeError("A reasoned Regulation 5 assessment is required")
  const input = value as Partial<ReasonableCancellationAssessment>
  if (!Number.isSafeInteger(input.assessedChargeCents) || input.assessedChargeCents! < 0 || input.assessedChargeCents! > ceilingCents) {
    throw new RangeError("The assessed exact charge must be non-negative and cannot exceed the financial ceiling")
  }
  const factors = {} as Record<Factor, string>
  for (const [key] of CPA_CANCELLATION_FACTORS) {
    const note = input.factors?.[key]
    if (typeof note !== "string" || !note.trim()) throw new RangeError(`Record the case-specific Regulation 5 factor: ${key}`)
    factors[key] = note.trim()
  }
  if (typeof input.rationale !== "string" || !input.rationale.trim()) throw new RangeError("Record why this amount is reasonable, including any reduction")
  if (typeof input.cancellationRightReason !== "string" || !input.cancellationRightReason.trim()) throw new RangeError("Explain why this charge does not negate the consumer's right to cancel (Regulation 5(3))")
  return { assessedChargeCents: input.assessedChargeCents!, ceilingCents, factors, rationale: input.rationale.trim(), cancellationRightReason: input.cancellationRightReason.trim() }
}
