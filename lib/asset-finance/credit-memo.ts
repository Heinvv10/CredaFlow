/**
 * Credit-memo ratios for an asset-finance deal (goal decision 2a.3). Pure: no
 * database, no clock. Money is integer cents; ratios are decimal STRINGS with
 * exactly four places, as stored in EntityFinancials.dscr / .gearing
 * (DECIMAL(9,4)).
 *
 * PROPOSED ANNUAL INSTALMENTS (the deal's own debt service)
 *   The schedule's instalments, balloon excluded, annualised over its term:
 *     proposedAnnual = round( Σ_rows (totalCents − balloonCents) × 12 / n )
 *   where n is the number of (monthly) periods. Annualising the whole term,
 *   rather than taking the first twelve months, gives seasonal, skip and
 *   step-up structures their true yearly burden. The balloon is left out: it
 *   is a one-off residual at the end, not a recurring payment. Rounded
 *   half-up to the cent (the value is never negative).
 *
 * DSCR (debt-service cover ratio)
 *   DSCR = EBITDA / (existing annual debt service + proposed annual instalments)
 *   EBITDA may be negative (a loss year); the debt service never is.
 *
 * GEARING
 *   gearing = total liabilities / total assets
 *
 * ROUNDING AND EDGES
 *   Each ratio is computed exactly in BIGINT arithmetic (inputs reach 9e15
 *   cents, so ×10 000 would leave Number's exact range) and rounded to four
 *   places, half away from zero. A zero denominator gives null (no ratio). A
 *   result beyond the column's ±99 999.9999 also gives null: it is not a
 *   meaningful cover or gearing figure, and the column cannot hold it.
 */

const ZERO = BigInt(0)
const SCALE = BigInt(10_000)
const MAX_SCALED = BigInt(999_999_999) // 99 999.9999 × 10 000: DECIMAL(9,4)

export interface InstalmentRow {
  totalCents: number
  balloonCents: number
}

export function proposedAnnualInstalmentsCents(rows: readonly InstalmentRow[]): number {
  if (rows.length === 0) return 0
  const instalments = rows.reduce((sum, row) => sum + (row.totalCents - row.balloonCents), 0)
  return Math.round((instalments * 12) / rows.length)
}

/** num / den rounded half away from zero to 4 places, as "d.dddd"; null for den 0 or out of range. */
export function ratio4(num: bigint, den: bigint): string | null {
  if (den === ZERO) return null
  const scaled = num * SCALE
  const negative = scaled < ZERO !== den < ZERO && scaled !== ZERO
  const absNum = scaled < ZERO ? -scaled : scaled
  const absDen = den < ZERO ? -den : den
  let quotient = absNum / absDen
  if ((absNum % absDen) * BigInt(2) >= absDen) quotient += BigInt(1)
  if (quotient > MAX_SCALED) return null
  const digits = `${quotient / SCALE}.${(quotient % SCALE).toString().padStart(4, "0")}`
  return negative && quotient !== ZERO ? `-${digits}` : digits
}

export function dscr(input: { ebitdaCents: number; existingDebtServiceCents: number; proposedAnnualCents: number }): string | null {
  return ratio4(BigInt(input.ebitdaCents), BigInt(input.existingDebtServiceCents) + BigInt(input.proposedAnnualCents))
}

export function gearing(input: { totalLiabilitiesCents: number; totalAssetsCents: number }): string | null {
  return ratio4(BigInt(input.totalLiabilitiesCents), BigInt(input.totalAssetsCents))
}

export interface CreditMemoFigures {
  ebitdaCents: number
  existingDebtServiceCents: number
  totalLiabilitiesCents: number
  totalAssetsCents: number
}

export interface CreditMemoRatios {
  proposedAnnualInstalmentsCents: number
  dscr: string | null
  gearing: string | null
}

export function computeCreditMemo(figures: CreditMemoFigures, schedule: readonly InstalmentRow[]): CreditMemoRatios {
  const proposedAnnual = proposedAnnualInstalmentsCents(schedule)
  return {
    proposedAnnualInstalmentsCents: proposedAnnual,
    dscr: dscr({ ...figures, proposedAnnualCents: proposedAnnual }),
    gearing: gearing(figures),
  }
}
