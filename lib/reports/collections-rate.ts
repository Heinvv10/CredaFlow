// Pure rate calculations for the board pack Executive Summary.
//
// Population convention: "Collections Rate" and "Arrears Rate" are computed
// over the COLLECTIBLE BOOK — see lib/loan/collectible-book.ts for exactly
// which statuses that is. A loan that is still owed belongs on both sides of
// the ratio (audit refs I-1/N-06/N-07).
//
// There is no longer a second convention to avoid mixing with: PAR30/60/90/NPL
// in lib/reports/par.ts use the same book. This comment used to say the book
// was "ACTIVE + DEFAULTED" and that par.ts was "ACTIVE-only to match the NCR
// quarterly return" — the first is now out of date and the second was never
// true of the NCR return, which used the wider population all along.
//
// Callers MUST pass counts/sums drawn from the same population on both
// sides of a given ratio. Mixing populations is exactly what made the board
// pack show "COLLECTIONS RATE -175%" / "ARREARS RATE 133.7%" (an
// ACTIVE-only denominator against an ACTIVE+DEFAULTED arrears numerator).
// Both functions guard against that instead of silently returning a
// nonsensical number: they log and return null so the caller can render an
// honest fallback.

/**
 * Share of `totalLoanCount` that is NOT currently in arrears.
 * Returns null (and logs) if `arrearsLoanCount` exceeds `totalLoanCount` —
 * a structural impossibility when both are drawn from the same population,
 * so this signals a population mismatch upstream rather than a real rate.
 */
export function computeCollectionsRate(totalLoanCount: number, arrearsLoanCount: number): number | null {
  if (totalLoanCount <= 0) return 100
  if (arrearsLoanCount > totalLoanCount) {
    console.error(
      `[reports/collections-rate] computeCollectionsRate: arrearsLoanCount (${arrearsLoanCount}) exceeds totalLoanCount (${totalLoanCount}) — population mismatch, refusing to render a rate.`
    )
    return null
  }
  return Math.round(((totalLoanCount - arrearsLoanCount) / totalLoanCount) * 100)
}

/**
 * Value of arrears as a percentage of the outstanding book.
 * Returns null (and logs) if `totalArrears` exceeds `book` — when both are
 * summed over the same population this signals a data/population problem
 * rather than a genuine >100% arrears rate.
 */
export function computeArrearsRate(totalArrears: number, book: number): string | null {
  if (book <= 0) return "0.0"
  if (totalArrears > book) {
    console.error(
      `[reports/collections-rate] computeArrearsRate: totalArrears (${totalArrears}) exceeds book (${book}) — population mismatch, refusing to render a rate.`
    )
    return null
  }
  return ((totalArrears / book) * 100).toFixed(1)
}
