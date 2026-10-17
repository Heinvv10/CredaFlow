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
  // The s127 shortfall/refund computation and legal citation are signed off (see DESIGN.md sign-off record 2026-10-17).
  return {
    shortfallCents: Math.max(0, input.settlementDueCents - input.saleProceedsCents),
    refundCents: Math.max(0, input.saleProceedsCents - input.settlementDueCents),
  }
}
