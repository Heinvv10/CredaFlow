/**
 * Re-solves the pending tail of a booked schedule when the rate moves
 * (DESIGN.md D4: term and balloon unchanged). Pure and deterministic, so the
 * same inputs always return identical rows (idempotent per loan and date).
 *
 * The rows after `paidThroughIndex` keep their index and due date and are
 * re-solved by the rules of solveStructure (./structure.ts): actual/365
 * simple daily interest rounded once per period, the last row absorbing the
 * rounding residue so the balance after its regular payment is exactly
 * `balloonCents`.
 *
 * NOTICE. Rows paidThroughIndex+1 .. keptThroughIndex (by default none) keep
 * their payment: they enter the solve as fixed amounts (weight 0, lump = their
 * payment), not as round(B × weight). They still accrue interest at the new
 * rate, so what they under- or over-charge against the old schedule is carried
 * in the balance and absorbed by the first re-solved row and those after it;
 * their stored split between interest and principal is recomputed accordingly
 * (./schedule-records.ts representation), their total is unchanged. The rows
 * after keptThroughIndex are re-solved with their weights; at least one must
 * remain (the last row absorbs the residue).
 *
 * Accrual restarts at `repriceDate`: the first pending row's interest covers
 * (repriceDate, its due date]. `balanceAtRepriceCents` is the balance that
 * bears interest from that date. Requires
 * rows[paidThroughIndex].dueDate <= repriceDate < rows[paidThroughIndex + 1].dueDate.
 *
 * A VAT-deferral lump is not visible in the rows, so a pending lump is NOT
 * preserved: reprice only after the VAT-deferral period is paid.
 *
 * Invalid input throws RangeError.
 */
import { amortise, type AmortisationResult } from "./amortise"
import { toDayNumber } from "./dates"
import { regularPaymentCents } from "./schedule-records"
import type { RatePoint, ScheduleRow } from "./types"

/**
 * Days of notice a borrower gets before a changed instalment falls due: a
 * repricing changes only rows due at least this many days after the run date.
 * PRODUCT SETTING TO CONFIRM WITH THE LENDER: 14 days is our default, not a
 * term taken from the lender's agreement; it must match the notice clause the
 * lender's legal team signs off.
 */
export const REPRICE_NOTICE_DAYS = 14

export interface RepriceInput {
  rows: ScheduleRow[] // the full current schedule, index 0..n-1
  paidThroughIndex: number // last index that is no longer PENDING, -1 if none
  keptThroughIndex?: number // last pending index that keeps its payment (notice); default paidThroughIndex
  balanceAtRepriceCents: number
  repriceDate: string
  ratePath: RatePoint[]
  balloonCents: number
}

/**
 * The last row whose payment a repricing run on `runDate` keeps: the settled
 * rows and every pending row due less than REPRICE_NOTICE_DAYS after runDate.
 */
export function noticeKeptThroughIndex(rows: ScheduleRow[], paidThroughIndex: number, runDate: string): number {
  const firstChangeableDay = toDayNumber(runDate, "runDate") + REPRICE_NOTICE_DAYS
  let kept = paidThroughIndex
  while (kept + 1 < rows.length && toDayNumber(rows[kept + 1].dueDate) < firstChangeableDay) kept++
  return kept
}

export function repriceRemaining(input: RepriceInput): ScheduleRow[] {
  return repriceTail(input).rows
}

/** repriceRemaining, also returning the new base instalment B it solved. */
export function repriceTail(input: RepriceInput): AmortisationResult {
  const { rows, paidThroughIndex: paid } = input
  rows.forEach((row, i) => {
    if (row.index !== i) throw new RangeError("rows: must be the full schedule, indexed 0..n-1")
  })
  if (!Number.isInteger(paid) || paid < -1 || paid >= rows.length - 1) {
    throw new RangeError("paidThroughIndex: must leave at least one pending row (-1 to n-2)")
  }
  const kept = input.keptThroughIndex ?? paid
  if (!Number.isInteger(kept) || kept < paid || kept >= rows.length - 1) {
    throw new RangeError("keptThroughIndex: must be from paidThroughIndex to n-2 (at least one row is re-solved)")
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
    periods: rows.slice(paid + 1).map((row) => row.index <= kept
      ? { dueDate: row.dueDate, weight: 0, lumpCents: regularPaymentCents(row) }
      : { dueDate: row.dueDate, weight: row.weight, lumpCents: 0 }),
    ratePath: input.ratePath,
    balloonCents: input.balloonCents,
  })
}
