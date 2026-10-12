import { calculateCreditLifeMonthlyPremiumCents } from "@/lib/insurance/credit-life-election"

export type AmountBounds = { minAmount: number; maxAmount: number } // cents

/**
 * The applicant's typed rand amount as whole cents, or null when it is blank,
 * not a number, or outside the product range. The amount field starts empty so
 * the figure is a deliberate choice; null blocks submit.
 */
export function validAmountCents(product: AmountBounds, input: string): number | null {
  if (input.trim() === "") return null
  const rand = Number(input)
  if (!Number.isFinite(rand)) return null
  const cents = Math.round(rand * 100)
  if (!Number.isSafeInteger(cents)) return null
  if (cents < product.minAmount || cents > product.maxAmount) return null
  return cents
}

/** Credit-life premium preview; 0 (never a throw) when there is no valid amount. */
export function creditLifePremiumForAmount(amountCents: number | null): number {
  return amountCents === null ? 0 : calculateCreditLifeMonthlyPremiumCents(amountCents)
}
