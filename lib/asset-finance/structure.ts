/**
 * Asset-finance deal-structure solver (docs/asset-finance/DESIGN.md D4, D6).
 * Pure: no database, no clock, no local time zone. Money is integer cents,
 * rates are decimals (0.1175 = 11.75% nominal p.a.), dates "YYYY-MM-DD".
 *
 * FINANCED AMOUNT
 *   F = cashPrice − deposit − tradeIn + financedFees. Every amount must be a
 *   non-negative integer; F > 0; 0 <= balloon < F.
 *
 * PERIODS AND DUE DATES
 *   One period per entry of `weights` (non-empty, each finite and >= 0, sum
 *   > 0, and the FINAL weight > 0 so the last row has an instalment to absorb
 *   the rounding residue). Period i is due on anchor + i months, the day of
 *   month taken from the anchor and clamped to the month's last day, always
 *   computed from the anchor (31 Jan → 28/29 Feb → 31 Mar). The anchor is
 *   `firstDueDate` (which must be after `startDate`); without it, period i is
 *   due on startDate + (i + 1) months, anchored on the start date's day.
 *
 * INTEREST
 *   Actual/365 fixed (365 in leap years too), simple daily interest on the
 *   balance outstanding at the start of the period — no intra-period
 *   compounding. Period i covers the days d in (previous due date, due date],
 *   the first period starting after `startDate`:
 *     interest_i = round( opening_i × Σ_d rate(d) / 365 )
 *   where rate(d) is the `ratePath` rate in effect on day d (a point applies
 *   from its effectiveDate inclusive; points strictly ascending; the first on
 *   or before startDate; rates >= 0). The interest is rounded to the cent ONCE
 *   per period, half-up (Math.round; the value is never negative).
 *
 * PAYMENTS
 *   Period i pays round(B × weight_i) cents, half-up, plus the VAT lump when
 *   i is the VAT-deferral period. A weight of 0 is a skip period.
 *   principal_i = payment_i − interest_i. It is negative when the payment does
 *   not cover the interest (a skip or low-weight period): the unpaid interest
 *   capitalises, i.e. it is added to the balance and bears interest from the
 *   next period on.
 *
 * VAT DEFERRAL
 *   `vatDeferralPeriods: { vatCents, periodIndex }`. The VAT is part of the
 *   cash price and therefore of F, and bears interest like the rest of F until
 *   it is repaid. It is repaid as one extra lump of exactly vatCents in period
 *   `periodIndex` (0-based), on top of that period's round(B × weight); B is
 *   solved with the lump treated as a known payment. 0 < vatCents < F − balloon.
 *
 * BALLOON
 *   The balloon is paid in the last row, on top of its instalment. Every row
 *   satisfies closing = opening + interest − total, where
 *   total = principal + interest + fees + balloon, so the balance after the
 *   last REGULAR payment (closing + balloon) equals balloonCents and the last
 *   row closes at 0. Σ principal + balloon = F.
 *
 * SOLVING B AND THE ROUNDING RESIDUE
 *   1. Real-valued pass, nothing rounded: the balance after the last regular
 *      payment is linear in B, so it is evaluated at B = 0 and B = 1 and the
 *      equation closing(B) = balloon is solved exactly.
 *   2. B = round(real B) — the integer base instalment, half-up.
 *   3. Cents pass with the rules above. Per-period rounding (interest and
 *      B × weight) leaves the balance a few cents off the balloon; the LAST
 *      row absorbs that residue: it pays opening + interest − balloon instead
 *      of round(B × weight) (+ lump), so the balance after it is exactly
 *      balloonCents. A residue that would make that payment negative is
 *      refused with a RangeError.
 *
 * FEES
 *   Fees are financed up front (inside F) in slice 1, so feesCents is 0 on
 *   every row; the column is kept for later slices.
 *
 * Invalid input throws RangeError.
 */
import { addMonthsClamped, toDayNumber } from "./dates"
import { amortise, assertCents, type AmortisationPeriod } from "./amortise"
import type { StructureInput, StructureResult } from "./types"

export type { RatePoint, ScheduleRow, StructureInput, StructureResult, VatDeferral } from "./types"

function dueDates(startDate: string, firstDueDate: string | undefined, periods: number): string[] {
  const startDay = toDayNumber(startDate, "startDate")
  if (firstDueDate !== undefined && toDayNumber(firstDueDate, "firstDueDate") <= startDay) {
    throw new RangeError("firstDueDate: must be after startDate")
  }
  return Array.from({ length: periods }, (_, i) =>
    firstDueDate === undefined ? addMonthsClamped(startDate, i + 1) : addMonthsClamped(firstDueDate, i),
  )
}

export function solveStructure(input: StructureInput): StructureResult {
  assertCents(input.cashPriceCents, "cashPriceCents")
  assertCents(input.depositCents, "depositCents")
  assertCents(input.tradeInCents, "tradeInCents")
  assertCents(input.financedFeesCents, "financedFeesCents")
  assertCents(input.balloonCents, "balloonCents")
  const financedAmountCents =
    input.cashPriceCents - input.depositCents - input.tradeInCents + input.financedFeesCents
  if (financedAmountCents <= 0) throw new RangeError("financed amount: must be more than 0")

  const n = input.weights.length
  const lumps = new Array<number>(n).fill(0)
  const vat = input.vatDeferralPeriods
  if (vat !== undefined) {
    assertCents(vat.vatCents, "vatDeferralPeriods.vatCents")
    if (!Number.isInteger(vat.periodIndex) || vat.periodIndex < 0 || vat.periodIndex >= n) {
      throw new RangeError("vatDeferralPeriods.periodIndex: must be a period of the schedule")
    }
    if (vat.vatCents <= 0 || vat.vatCents >= financedAmountCents - input.balloonCents) {
      throw new RangeError("vatDeferralPeriods.vatCents: must be > 0 and less than the financed amount less the balloon")
    }
    lumps[vat.periodIndex] = vat.vatCents
  }

  const dates = dueDates(input.startDate, input.firstDueDate, n)
  const periods: AmortisationPeriod[] = input.weights.map((weight, i) => ({ dueDate: dates[i], weight, lumpCents: lumps[i] }))
  const { baseInstalmentCents, rows } = amortise({
    firstIndex: 0,
    openingCents: financedAmountCents,
    accrualStartDate: input.startDate,
    periods,
    ratePath: input.ratePath,
    balloonCents: input.balloonCents,
  })

  return {
    financedAmountCents,
    baseInstalmentCents,
    rows,
    totalInterestCents: rows.reduce((sum, row) => sum + row.interestCents, 0),
    totalPayableCents: rows.reduce((sum, row) => sum + row.totalCents, 0),
  }
}
