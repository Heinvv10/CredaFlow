/**
 * A lease deal's structure, priced (slice 3, C2): the bridge between the
 * stored deal terms and the pure lease pricing (./lease-pricing.ts), as
 * ./deal-structure.ts is for an instalment sale.
 *
 * START DATE. ADVANCE: the lease commences on its first rental's due date
 * (firstDueDate), the rental paid that day. ARREARS: as an instalment sale,
 * the indicative start is one month before firstDueDate; booking re-prices
 * from the planned start.
 *
 * WHAT IS SIGNED. The base rental (signedBaseInstalmentCents), the finance
 * charges the rentals carry (signedTotalInterestCents: Σ of the solver's
 * period interest) and the rate. None of them depends on VAT, so origination
 * prices at VAT 0 and the VAT is added with the rate in force where it is
 * shown or booked (priceLeaseTerms with a VAT rate).
 *
 * TERM. The lease runs `n` months from commencement on ADVANCE, and to the
 * last due date on ARREARS; termDays is that span (the product's term bounds).
 */
import { addMonthsClamped, toDayNumber } from "./dates"
import { MAX_INT } from "./input-fields"
import { priceLease, type LeasePricingResult } from "./lease-pricing"
import type { LeaseTerms } from "./lease-input"
import type { StructureTerms } from "./deal-input"
import type { AssetPrice, ResolvedRate } from "./deal-structure"
import type { StructureResult } from "./types"

export type LeaseTermsOf = StructureTerms & { lease: LeaseTerms }

export const isLeaseTerms = (terms: StructureTerms): terms is LeaseTermsOf => terms.lease !== undefined

/** The indicative commencement of a lease (header). */
export function leaseStartDate(terms: LeaseTermsOf): string {
  return terms.lease.rentalTiming === "ADVANCE" ? terms.firstDueDate : addMonthsClamped(terms.firstDueDate, -1)
}

/** The day the lease term ends: the asset is returned or the end-of-term option exercised. */
export function leaseEndDate(terms: LeaseTermsOf, startDate: string): string {
  const n = terms.weights.length
  return terms.lease.rentalTiming === "ADVANCE" ? addMonthsClamped(startDate, n) : addMonthsClamped(terms.firstDueDate, n - 1)
}

export type LeaseSolved =
  | { ok: true; rate: ResolvedRate; startDate: string; result: StructureResult; termDays: number; lease: LeasePricingResult }
  | { ok: false; error: string }

/** The structure result the instalment-sale callers read: capital rows, base rental, finance charges. */
function structureResult(lease: LeasePricingResult): StructureResult {
  const rows = lease.periods.map((p) => p.row)
  return {
    financedAmountCents: lease.capitalCents,
    baseInstalmentCents: lease.baseRentalCents,
    rows,
    totalInterestCents: rows.reduce((sum, row) => sum + row.interestCents, 0),
    totalPayableCents: rows.reduce((sum, row) => sum + row.totalCents, 0),
  }
}

export function priceLeaseTerms(
  asset: AssetPrice,
  terms: LeaseTermsOf,
  rate: ResolvedRate,
  startDate: string,
  vatRateTenThousandths: number,
): LeaseSolved {
  let lease: LeasePricingResult
  try {
    const { maintenance } = terms.lease
    lease = priceLease({
      cashPriceExclVatCents: asset.cashPriceExclVatCents,
      residualCents: terms.balloonCents,
      periods: terms.weights.length,
      rentalTiming: terms.lease.rentalTiming,
      escalationRate: terms.lease.escalationRate,
      startDate,
      firstDueDate: terms.lease.rentalTiming === "ADVANCE" ? undefined : terms.firstDueDate,
      ratePath: [{ effectiveDate: startDate, annualRate: Number(rate.annualRate) }],
      maintenance: maintenance && { monthlyExclVatCents: maintenance.monthlyExclVatCents, escalationRate: maintenance.escalationRate },
      vatRateTenThousandths,
    })
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, error: error.message }
    throw error
  }
  if (terms.lease.rentalTiming === "ADVANCE" && startDate !== terms.firstDueDate) {
    return { ok: false, error: `A rental in advance commences on its first due date (${terms.firstDueDate}), not ${startDate}` }
  }
  if (lease.capitalCents > MAX_INT || lease.baseRentalCents > MAX_INT || lease.periods.some((p) => p.totalCents > MAX_INT)) {
    return { ok: false, error: "The lease capital or a rental is too large" }
  }
  const termDays = toDayNumber(leaseEndDate(terms, startDate)) - toDayNumber(startDate)
  return { ok: true, rate, startDate, result: structureResult(lease), termDays, lease }
}
