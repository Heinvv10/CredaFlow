interface SurrenderOutcomeInput {
  settlementDueCents: number
  saleProceedsCents: number
}

/** Pure s127 result after sale proceeds are applied to the live settlement. */
export function surrenderOutcome(input: SurrenderOutcomeInput): {
  shortfallCents: number
  refundCents: number
} {
  if (!Number.isSafeInteger(input.settlementDueCents) || input.settlementDueCents < 0) {
    throw new RangeError("Settlement due must be non-negative integer cents")
  }
  if (!Number.isSafeInteger(input.saleProceedsCents) || input.saleProceedsCents < 0) {
    throw new RangeError("Sale proceeds must be non-negative integer cents")
  }
  // UNTESTED: s127 shortfall/refund computation and legal citation require lender legal sign-off.
  return {
    shortfallCents: Math.max(0, input.settlementDueCents - input.saleProceedsCents),
    refundCents: Math.max(0, input.saleProceedsCents - input.settlementDueCents),
  }
}
