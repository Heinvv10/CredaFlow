/**
 * Re-solves the pending tail of a booked schedule when the rate moves
 * (DESIGN.md D4: term and balloon unchanged). Pure and deterministic, so the
 * same inputs always return identical rows (idempotent per loan and date).
 *
 * The rows after `paidThroughIndex` keep their index, due date and weight; a
 * new base instalment B is solved over them with the rules of solveStructure
 * (./structure.ts): actual/365 simple daily interest rounded once per period,
 * round(B × weight) payments, the last row absorbing the rounding residue so
 * the balance after its regular payment is exactly `balloonCents`.
 *
 * Accrual restarts at `repriceDate`: the first replacement row's interest
 * covers the days (repriceDate, its due date]. `balanceAtRepriceCents` is the
 * balance that bears interest from that date — the capital outstanding plus
 * any interest accrued since the last paid row's due date and not otherwise
 * charged. When repriceDate equals that due date, it is simply the capital
 * outstanding. Requires rows[paidThroughIndex].dueDate <= repriceDate <
 * rows[paidThroughIndex + 1].dueDate and at least one pending row.
 *
 * A VAT-deferral lump is not visible in the rows, so a pending lump is NOT
 * preserved: reprice only after the VAT-deferral period is paid.
 *
 * Invalid input throws RangeError.
 */
import { amortise } from "./amortise"
import { toDayNumber } from "./dates"
import type { RatePoint, ScheduleRow } from "./types"

export interface RepriceInput {
  rows: ScheduleRow[] // the full current schedule, index 0..n-1
  paidThroughIndex: number // last index that is no longer PENDING, -1 if none
  balanceAtRepriceCents: number
  repriceDate: string
  ratePath: RatePoint[]
  balloonCents: number
}

export function repriceRemaining(input: RepriceInput): ScheduleRow[] {
  const { rows, paidThroughIndex: paid } = input
  rows.forEach((row, i) => {
    if (row.index !== i) throw new RangeError("rows: must be the full schedule, indexed 0..n-1")
  })
  if (!Number.isInteger(paid) || paid < -1 || paid >= rows.length - 1) {
    throw new RangeError("paidThroughIndex: must leave at least one pending row (-1 to n-2)")
  }
  const repriceDay = toDayNumber(input.repriceDate, "repriceDate")
  if (paid >= 0 && repriceDay < toDayNumber(rows[paid].dueDate)) {
    throw new RangeError("repriceDate: must not be before the last paid row's due date")
  }
  // The first pending due date must be after repriceDate; amortise enforces it.
  return amortise({
    firstIndex: paid + 1,
    openingCents: input.balanceAtRepriceCents,
    accrualStartDate: input.repriceDate,
    periods: rows.slice(paid + 1).map((row) => ({ dueDate: row.dueDate, weight: row.weight, lumpCents: 0 })),
    ratePath: input.ratePath,
    balloonCents: input.balloonCents,
  }).rows
}
