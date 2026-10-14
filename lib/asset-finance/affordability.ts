export interface AssetAffordabilityInput {
  borrower: "ENTITY" | "SOLE_PROPRIETOR"
  annualTurnoverCents: number
  averageMonthlyCreditsCents: number
  existingDebtServiceCents: number
  proposedInstalmentCents: number
  personalNdiCents: number | null
}

export interface AssetAffordabilityResult {
  verifiedBusinessIncomeCents: number
  businessNdiBeforeProposedCents: number
  personalNdiCents: number | null
  combinedNdiAfterProposedCents: number
  affordable: boolean
}

const cents = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be non-negative integer cents`)
}

/** Pure s81 working. The lower income source is used so neither AFS nor bank credits can inflate the result alone. */
export function assessAssetFinanceAffordability(input: AssetAffordabilityInput): AssetAffordabilityResult {
  cents(input.annualTurnoverCents, "annualTurnoverCents")
  cents(input.averageMonthlyCreditsCents, "averageMonthlyCreditsCents")
  cents(input.existingDebtServiceCents, "existingDebtServiceCents")
  cents(input.proposedInstalmentCents, "proposedInstalmentCents")
  if (input.borrower === "SOLE_PROPRIETOR" && input.personalNdiCents === null) {
    throw new RangeError("A sole proprietor needs the existing consumer personal NDI")
  }
  if (input.personalNdiCents !== null) cents(input.personalNdiCents, "personalNdiCents")
  const verifiedBusinessIncomeCents = Math.min(
    input.averageMonthlyCreditsCents,
    Math.floor(input.annualTurnoverCents / 12),
  )
  const businessNdiBeforeProposedCents = verifiedBusinessIncomeCents - input.existingDebtServiceCents
  const combinedNdiAfterProposedCents = businessNdiBeforeProposedCents
    + (input.personalNdiCents ?? 0)
    - input.proposedInstalmentCents
  return {
    verifiedBusinessIncomeCents,
    businessNdiBeforeProposedCents,
    personalNdiCents: input.personalNdiCents,
    combinedNdiAfterProposedCents,
    affordable: combinedNdiAfterProposedCents >= 0,
  }
}
