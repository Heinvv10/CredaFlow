/**
 * An intermediary's commission is a share of the PREMIUM, never of the sum
 * assured (a 20% rate on R20 000 of cover would be R4 000 on a R118/month
 * policy). Rands, rounded to the cent. `rate` is a fraction (0.15 = 15%).
 *
 * lib/insurance/policy/bind.ts computes the quote path's figure the same way.
 */
export function premiumCommission(premiumAmount: number, rate: number): number {
  return Number((premiumAmount * rate).toFixed(2))
}
