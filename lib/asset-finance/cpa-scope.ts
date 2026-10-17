import { CPA_JURISTIC_THRESHOLD_CENTS } from "./cpa-thresholds"

// Decides whether the Consumer Protection Act governs a lease (slice 3, C1;
// its fixed-term rules, s14, drive the expiry notice and cancellation). Pure:
// the caller snapshots the result on the deal and the loan. Anything the
// documents do not prove resolves to "applies", as the NCA classifier does.
// Signed off (see DESIGN.md sign-off record 2026-10-17).

export type CpaScopeInput =
  | { lessee: "NATURAL_PERSON" }
  | {
      lessee: "JURISTIC"
      entityType: "COMPANY" | "CC" | "TRUST" | "PARTNERSHIP"
      annualTurnoverCents: number | null
      totalAssetValueCents: number | null
      financialsEvidenceIds: string[]
      financialsVerified: boolean
    }

/** Every rule classifyCpaScope returns; the database refuses any other (AssetFinanceDeal / Loan CHECKs). */
export const CPA_RULE_IDS = [
  "CPA_NATURAL_PERSON",
  "CPA_FINANCIALS_UNPROVEN",
  "CPA_JURISTIC_OVER_THRESHOLD",
  "CPA_JURISTIC_UNDER_THRESHOLD",
] as const
export type CpaRuleId = (typeof CPA_RULE_IDS)[number]

export interface CpaScope {
  applies: boolean
  rule: CpaRuleId
  reason: string
  evidenceIds: string[]
}

function assertCents(name: string, value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative integer number of cents, got ${value}`)
  }
}

const rands = (cents: number): string => `R${Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`

export function classifyCpaScope(input: CpaScopeInput): CpaScope {
  if (input.lessee === "NATURAL_PERSON") {
    return { applies: true, rule: "CPA_NATURAL_PERSON", reason: "The lessee is a natural person: the CPA applies.", evidenceIds: [] }
  }
  assertCents("annualTurnoverCents", input.annualTurnoverCents)
  assertCents("totalAssetValueCents", input.totalAssetValueCents)
  const evidenceIds = [...input.financialsEvidenceIds]
  const { annualTurnoverCents: turnover, totalAssetValueCents: assets } = input
  const proven = evidenceIds.length > 0 && input.financialsVerified
  // Excluded when asset value OR turnover "equals or exceeds" the threshold (s6).
  const over = [turnover, assets].find((v): v is number => v !== null && v >= CPA_JURISTIC_THRESHOLD_CENTS)
  if (proven && over !== undefined) {
    return {
      applies: false, rule: "CPA_JURISTIC_OVER_THRESHOLD", evidenceIds,
      reason: `Juristic lessee with annual turnover or asset value of ${rands(over)}, at or above ${rands(CPA_JURISTIC_THRESHOLD_CENTS)}: the CPA does not apply (s5(2)(b)).`,
    }
  }
  if (!proven || turnover === null || assets === null) {
    return {
      applies: true, rule: "CPA_FINANCIALS_UNPROVEN", evidenceIds,
      reason: "The lessee's turnover and asset value are not both proven below the threshold by verified financial statements, so the CPA applies.",
    }
  }
  return {
    applies: true, rule: "CPA_JURISTIC_UNDER_THRESHOLD", evidenceIds,
    reason: `Juristic lessee with turnover and asset value below ${rands(CPA_JURISTIC_THRESHOLD_CENTS)}: the CPA applies.`,
  }
}
