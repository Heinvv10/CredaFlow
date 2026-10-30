import { isNcaJurisdiction } from "@/lib/jurisdiction/active"

// NCA statutory ceiling on the initiation fee.
//
// ⚠️ THESE FIGURES ARE GAZETTED AND CHANGE. They are collected here, named, so
// legal can verify and update them in ONE place. Confirm against the current
// NCA Regulation 42 schedule before relying on them.
//
// The product catalogue configures the initiation fee as a flat percentage with
// a flat cap (`initiationFeePct`, `initiationFeeMax`). That is a commercial
// setting, not a legal one — nothing stopped a product from being configured
// above the prescribed maximum, and one was: a R3,000 Micro Loan at a flat 15%
// charged R450 against a statutory ceiling of ~R419.75.
//
// The statute is TIERED, not a flat percentage:
//     R165 for the first R1,000, plus 10% of the amount above R1,000,
//     never exceeding R1,050 — all EXCLUDING VAT, which may be added.
//
// A flat percentage can only match that by coincidence. Over the R2,200–R8,500
// band — where the micro-loan products actually operate — 15% exceeds it.
//
// Reg 42 imposes a SECOND, independent ceiling: the initiation fee may not
// exceed 15% of the principal debt. The two bind over different bands, so both
// must be applied — the tier alone is NOT the maximum. Below ~R2,136 the 15%
// ceiling is the lower of the two (at R2,000 the tier permits R304.75 while
// 15% permits R300.00 — R4.75 of over-charge on every such loan), and above it
// the tier takes over. Neither ceiling subsumes the other.
export const NCA_INITIATION_FEE_CAP = {
  /** Base fee for the first tranche, in cents, EXCLUDING VAT. */
  baseFeeExclVat: 16_500, // R165.00
  /** Principal up to which only the base fee applies, in cents. */
  baseThreshold: 100_000, // R1,000.00
  /** Marginal rate applied to principal above the threshold. */
  marginalRate: 0.1, // 10%
  /** Absolute ceiling regardless of principal, in cents, EXCLUDING VAT. */
  ceilingExclVat: 105_000, // R1,050.00
  /** VAT added on top of the statutory (excl-VAT) maximum. */
  vatRate: 0.15,
  /**
   * Independent ceiling: the fee may never exceed this share of the principal
   * debt, however the tiered calculation lands.
   *
   * ⚠️ Applied to the VAT-INCLUSIVE fee — i.e. what the consumer actually pays
   * is held to 15% of principal. Reading it against the excl-VAT figure instead
   * would permit 17.25% incl VAT. Legal must confirm which the regulation means;
   * this module takes the consumer-protective reading.
   */
  principalPctCeiling: 0.15,
} as const

/**
 * Maximum initiation fee chargeable on `principal`, in cents, INCLUDING VAT —
 * the figure to compare a configured fee against, since what the consumer pays
 * is VAT-inclusive.
 */
export function ncaInitiationFeeCap(principalCents: number): number {
  const c = NCA_INITIATION_FEE_CAP
  if (principalCents <= 0) return 0
  const excess = Math.max(0, principalCents - c.baseThreshold)
  const exclVat = Math.min(c.baseFeeExclVat + excess * c.marginalRate, c.ceilingExclVat)
  const tiered = Math.round(exclVat * (1 + c.vatRate))
  const shareOfPrincipal = Math.round(principalCents * c.principalPctCeiling)
  return Math.min(tiered, shareOfPrincipal)
}

/**
 * Credit categories EXEMPT from the consumer ceiling above.
 *
 * Deny-by-default: anything not listed here is capped, including a product type
 * this module has never heard of. The inverse (list the consumer types, exempt
 * everything else) fails OPEN — add a `BUSINESS` or `VEHICLE` value to
 * `enum ProductType` and the statutory ceiling would silently stop applying to
 * it, with no test and no error. A statutory maximum must never be disabled by
 * omission.
 *
 * PO_FUNDING is exempt because Reg 42 sets different maxima per credit category
 * and purchase-order funding is business/developmental credit — a juristic
 * person above the s.4 threshold is outside the Act entirely. Applying the
 * unsecured-consumer ceiling would clamp a R10,000 fee on a R500,000 facility
 * to R1,207.50, a pricing bug rather than a compliance fix.
 *
 * ⚠️ The correct developmental / business maximum is NOT implemented — legal
 * must supply it. Until then PO_FUNDING keeps its configured commercial rate.
 */
const FEE_CAP_EXEMPT_TYPES: ReadonlySet<string> = new Set(["PO_FUNDING"])

/**
 * Applies the statutory ceiling to a commercially-configured fee. Always the
 * LESSER of the two: a product may charge less than the maximum, never more.
 *
 * `productType` selects the regime. Absent OR unrecognised => capped, because
 * under-charging a business facility is a commercial error while over-charging
 * a consumer is a statutory breach.
 *
 * `ncaRegime` is the agreement's Loan/LoanApplication.ncaRegime. Reg 42 binds
 * NCA credit agreements only, so a NON_NCA (asset finance) agreement keeps its
 * configured fee, and so does every agreement of a lender outside the NCA's
 * jurisdiction (lib/jurisdiction). Absent => NCA => capped, the same fail-closed default. Today
 * only calculateLoan calls this, and it prices consumer (NCA) credit only.
 */
export function capInitiationFee(
  configuredFeeCents: number,
  principalCents: number,
  productType?: string | null,
  ncaRegime: "NCA" | "NON_NCA" = "NCA",
): number {
  if (ncaRegime === "NON_NCA" || !isNcaJurisdiction()) return configuredFeeCents
  if (productType && FEE_CAP_EXEMPT_TYPES.has(productType)) return configuredFeeCents
  return Math.min(configuredFeeCents, ncaInitiationFeeCap(principalCents))
}
