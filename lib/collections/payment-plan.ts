/**
 * Payment-plan instalment split, in integer cents. `PaymentPlan` stores one
 * `installmentAmt` (the regular instalment), so the final instalment is derived
 * here, never stored: it absorbs the rounding remainder so the plan sums exactly
 * to `totalArrears`.
 */
export interface PaymentPlanSplit {
  /** Instalments 1..n-1 (and n when the total divides evenly), cents. */
  regularCents: number
  /** The last instalment, cents. Always >= regularCents. */
  finalCents: number
}

export function splitPaymentPlan(totalCents: number, installments: number): PaymentPlanSplit {
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new RangeError("totalCents must be a positive integer")
  }
  if (!Number.isInteger(installments) || installments < 1) {
    throw new RangeError("installments must be a positive integer")
  }
  const regularCents = Math.floor(totalCents / installments)
  return { regularCents, finalCents: totalCents - regularCents * (installments - 1) }
}
