// Dependency-free, so client components can import it.
import type { Jurisdiction } from "@/lib/jurisdiction/profiles"

export const MOBILE_MONEY_METHOD = "MOBILE_MONEY"
/** How a MOBILE_MONEY receipt is named everywhere: a brand, the same in every language. */
export const MOBILE_MONEY_LABEL = "M-Pesa"

/** Where staff are offered M-Pesa as a payment method. ZA and LS forms are unchanged. */
const MOBILE_MONEY_JURISDICTIONS: readonly Jurisdiction[] = ["KE"]

export function mobileMoneyCaptureOffered(jurisdiction: Jurisdiction): boolean {
  return MOBILE_MONEY_JURISDICTIONS.includes(jurisdiction)
}
