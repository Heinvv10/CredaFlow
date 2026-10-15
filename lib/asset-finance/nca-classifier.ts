import {
  NCA_JURISTIC_THRESHOLD_CENTS,
  NCA_LARGE_AGREEMENT_THRESHOLD_CENTS,
  NCA_TRUST_MIN_TRUSTEES_FOR_JURISTIC,
} from "./nca-thresholds"

// Decides whether the NCA governs a business borrower's agreement (DESIGN D5).
// Pure: the result and its evidence ids are snapshotted on the application by
// the caller. Anything the documents do not prove resolves to NCA.
//
// The turnover and asset figures must already include all related juristic
// persons (s4(1)(a)(i) tests the combined value); this function does not
// aggregate them.

export interface NcaClassifierInput {
  entityType: "COMPANY" | "CC" | "TRUST" | "PARTNERSHIP"
  trustees: { kind: "NATURAL" | "JURISTIC" }[] // active TRUSTEE relationships; ignored unless TRUST
  annualTurnoverCents: number | null
  totalAssetValueCents: number | null
  financialsEvidenceIds: string[] // AFS / management accounts document ids
  financialsVerified: boolean // staff confirmed the figures against the evidence
  trusteeEvidenceIds: string[] // Letters of Authority document ids (trusts)
  principalDebtCents: number
}

/**
 * Every rule the classifier returns. The database refuses any other value in
 * LoanApplication.ncaClassificationRule and NcaRegimeOverride.approvedClassificationRule
 * (CHECKs in 20261013090000_asset_finance_foundation; nca-rule-ids.test.ts holds them equal).
 */
export const NCA_RULE_IDS = [
  "NATURAL_PERSON_NCA",
  "TRUST_FEW_NATURAL_TRUSTEES",
  "TRUST_UNEVIDENCED",
  "FINANCIALS_UNPROVEN",
  "JURISTIC_OVER_THRESHOLD",
  "LARGE_AGREEMENT",
  "JURISTIC_SMALL_AGREEMENT",
] as const

/**
 * Not a classifier result: an operating or full-maintenance lease is written
 * NON_NCA on this rule at creation (./lease-deal.ts). The database admits it
 * on an application only (LoanApplication_nca_classification_rule_known).
 */
export const LEASE_RULE_ID = "LEASE_NOT_CREDIT_AGREEMENT"

export type NcaRuleId = (typeof NCA_RULE_IDS)[number]

export interface NcaClassification {
  regime: "NCA" | "NON_NCA"
  rule: NcaRuleId
  reason: string
  evidenceIds: string[]
  inputs: NcaClassifierInput
}

function assertCents(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of cents, got ${value}`)
  }
}

function rands(cents: number): string {
  // "R1 000 000" — whole rands, space-grouped, for staff-facing reasons.
  return `R${Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`
}

const ENTITY_LABEL: Record<NcaClassifierInput["entityType"], string> = {
  COMPANY: "Company",
  CC: "Close corporation",
  TRUST: "Trust",
  PARTNERSHIP: "Partnership",
}

export function classifyNcaRegime(input: NcaClassifierInput): NcaClassification {
  assertCents("principalDebtCents", input.principalDebtCents)
  if (input.annualTurnoverCents !== null) assertCents("annualTurnoverCents", input.annualTurnoverCents)
  if (input.totalAssetValueCents !== null) assertCents("totalAssetValueCents", input.totalAssetValueCents)

  const inputs: NcaClassifierInput = {
    ...input,
    trustees: input.trustees.map((t) => ({ kind: t.kind })),
    financialsEvidenceIds: [...input.financialsEvidenceIds],
    trusteeEvidenceIds: [...input.trusteeEvidenceIds],
  }
  const result = (
    regime: NcaClassification["regime"],
    rule: NcaRuleId,
    reason: string,
    evidenceIds: string[],
  ): NcaClassification => ({ regime, rule, reason, evidenceIds, inputs })

  const isTrust = inputs.entityType === "TRUST"
  const trusteeEvidence = isTrust ? inputs.trusteeEvidenceIds : []

  if (isTrust) {
    const n = inputs.trustees.length
    if (inputs.trusteeEvidenceIds.length === 0 || n === 0) {
      return result(
        "NCA",
        "TRUST_UNEVIDENCED",
        "Trust without Letters of Authority or recorded trustees: its trustees are unproven, so the NCA applies.",
        trusteeEvidence,
      )
    }
    if (n < NCA_TRUST_MIN_TRUSTEES_FOR_JURISTIC && inputs.trustees.every((t) => t.kind === "NATURAL")) {
      return result(
        "NCA",
        "TRUST_FEW_NATURAL_TRUSTEES",
        `Trust with ${n} trustee${n === 1 ? "" : "s"}, all natural persons: the NCA applies (s1, definition of "juristic person").`,
        trusteeEvidence,
      )
    }
  }

  // Every remaining case is a juristic person: a company, a CC, a partnership
  // (s1 includes any body of persons, corporate or unincorporated) or a trust
  // that cleared the trustee rule above.
  const label = ENTITY_LABEL[inputs.entityType]
  const evidence = [...trusteeEvidence, ...inputs.financialsEvidenceIds]
  const { annualTurnoverCents: turnover, totalAssetValueCents: assets } = inputs

  if (
    inputs.financialsEvidenceIds.length === 0 ||
    !inputs.financialsVerified ||
    (turnover === null && assets === null)
  ) {
    return result(
      "NCA",
      "FINANCIALS_UNPROVEN",
      `${label} turnover and asset value are not proven by verified financial statements, so the NCA applies.`,
      evidence,
    )
  }

  // Boundaries: the Act is excluded when asset value or turnover "equals or
  // exceeds" the threshold (s4(1)(a)(i)), and a large agreement is principal
  // debt "at or above" the higher threshold (s9(4)(b)). Both are >=.
  // UNTESTED: boundary to confirm with legal
  const size = Math.max(turnover ?? 0, assets ?? 0)
  if (size >= NCA_JURISTIC_THRESHOLD_CENTS) {
    return result(
      "NON_NCA",
      "JURISTIC_OVER_THRESHOLD",
      `${label} with annual turnover or asset value of ${rands(size)}, at or above ${rands(NCA_JURISTIC_THRESHOLD_CENTS)}: the NCA does not apply (s4(1)(a)(i)).`,
      evidence,
    )
  }
  if (inputs.principalDebtCents >= NCA_LARGE_AGREEMENT_THRESHOLD_CENTS) {
    return result(
      "NON_NCA",
      "LARGE_AGREEMENT",
      `${label} below ${rands(NCA_JURISTIC_THRESHOLD_CENTS)} borrowing ${rands(inputs.principalDebtCents)}, at or above ${rands(NCA_LARGE_AGREEMENT_THRESHOLD_CENTS)}: a large agreement, so the NCA does not apply (s4(1)(b)).`,
      evidence,
    )
  }
  return result(
    "NCA",
    "JURISTIC_SMALL_AGREEMENT",
    `${label} below ${rands(NCA_JURISTIC_THRESHOLD_CENTS)} borrowing ${rands(inputs.principalDebtCents)}, below ${rands(NCA_LARGE_AGREEMENT_THRESHOLD_CENTS)}: the NCA applies.`,
    evidence,
  )
}
