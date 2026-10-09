export const DISBURSEMENT_PRECONDITION_ORDER = [
  "acknowledged_pasq",
  "signed_agreement",
  "provider_countersign",
  "composite_kyc",
  "unchanged_affordability",
  "verified_banking",
  "signed_debit_mandate",
  "insurance_election",
] as const

export type DisbursementPrecondition =
  (typeof DISBURSEMENT_PRECONDITION_ORDER)[number]

export type DisbursementPreconditionResult = {
  ok: boolean
  evidence?: string | null
}

export type DisbursementPreconditionChecks = Record<
  DisbursementPrecondition,
  DisbursementPreconditionResult
>

const PRECONDITION_MESSAGES: Record<DisbursementPrecondition, string> = {
  acknowledged_pasq:
    "The exact PASQ acknowledged by the customer must remain integrity-bound to approval.",
  signed_agreement:
    "The exact customer-signed credit agreement and its stored bytes must be intact.",
  provider_countersign:
    "The credit provider must countersign the exact customer-signed agreement.",
  composite_kyc:
    "Current composite KYC must contain valid biometric evidence, an exact reasoned senior exception, or a recorded in-person verification.",
  unchanged_affordability:
    "The immutable affordability decision and contract evidence must be unchanged.",
  verified_banking:
    "The payout account must match an integrity-bound verified bank statement.",
  signed_debit_mandate:
    "The customer must sign the exact debit mandate for the current account and schedule.",
  insurance_election:
    "The credit-life election and disclosure must be resolved and unchanged.",
}

export class DisbursementPreconditionError extends Error {
  constructor(
    readonly precondition: DisbursementPrecondition,
    readonly evidence: string | null,
  ) {
    super(PRECONDITION_MESSAGES[precondition])
    this.name = "DisbursementPreconditionError"
  }
}

/**
 * One fail-closed money-path spine. Callers pass the independently verified
 * evidence results; the first missing requirement is surfaced with a stable,
 * machine-readable reason.
 */
export function assertDisbursementPreconditions(
  checks: DisbursementPreconditionChecks,
): void {
  for (const precondition of DISBURSEMENT_PRECONDITION_ORDER) {
    const result = checks[precondition]
    if (!result.ok) {
      throw new DisbursementPreconditionError(
        precondition,
        result.evidence ?? null,
      )
    }
  }
}
