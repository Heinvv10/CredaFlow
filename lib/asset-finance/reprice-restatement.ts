/** Reallocate historical scheduled cash at a late-recorded rate's true date.
 * Cash amounts, dates and paid totals stay fixed. The corrected principal /
 * interest split and closing balance give the future solve its true opening.
 */
import { sastCalendarDate } from "@/lib/date/sast"
import { DAY_COUNT_BASIS, periodInterest } from "./amortise"
import { toDayNumber } from "./dates"
import { rateDaySum, rateSegments } from "./rates"
import type { StoredScheduleRow } from "./stored-schedule"
import type { RatePoint, ScheduleRow } from "./types"

interface RestatementInput {
  stored: StoredScheduleRow[]
  paidThroughIndex: number
  originalClosingBalanceCents: number
  startDate: string
  oldPath: RatePoint[]
  newPath: RatePoint[]
  effectiveDate: string
}
export interface RateRestatement {
  rows: ScheduleRow[]
  closingBalanceCents: number
  /** Signed correction to the balance: negative is a credit to the borrower. */
  adjustmentCents: number
}
const capitalCash = (row: StoredScheduleRow) => row.totalDue - row.feesDue

export function restateSettledSchedule(input: RestatementInput): RateRestatement {
  const { stored, paidThroughIndex: paid, originalClosingBalanceCents: original } = input
  const first = stored.findIndex((row, i) => i <= paid && sastCalendarDate(row.dueDate) >= input.effectiveDate)
  if (first < 0) return { rows: [], closingBalanceCents: original, adjustmentCents: 0 }
  const days = stored.map((row) => toDayNumber(sastCalendarDate(row.dueDate)))
  const start = toDayNumber(input.startDate)
  const oldSegments = rateSegments(input.oldPath, start)
  const newSegments = rateSegments(input.newPath, start)
  const periodStart = (i: number) => i === 0 ? start : days[i - 1]
  const snapshot = stored[first].assetFinanceOpeningBalanceCents
  let opening: number
  if (snapshot == null) {
    // Older rows have no snapshot. Invert the old contractual cash path from
    // the independently reconstructed balance after the last settled period.
    let after = original
    for (let i = paid; i >= first; i--) {
      const rateDays = rateDaySum(oldSegments, periodStart(i), days[i])
      const target = after + capitalCash(stored[i])
      const guess = Math.round(target / (1 + rateDays / DAY_COUNT_BASIS))
      const exact = [guess - 2, guess - 1, guess, guess + 1, guess + 2]
        .find((value) => value >= 0 && value + periodInterest(value, rateDays) === target)
      if (exact === undefined) throw new Error("Cannot reconstruct historical capital for the rate correction")
      after = exact
    }
    opening = after
  } else { opening = snapshot }
  if (!Number.isSafeInteger(opening) || opening < 0) throw new Error("Invalid historical opening capital")
  const rows: ScheduleRow[] = []
  for (let i = first; i <= paid; i++) {
    const interest = periodInterest(Math.max(0, opening), rateDaySum(newSegments, periodStart(i), days[i]))
    const payment = capitalCash(stored[i])
    const closing = opening + interest - payment
    rows.push({ index: i, dueDate: sastCalendarDate(stored[i].dueDate), weight: 0, openingBalanceCents: opening,
      interestCents: interest, principalCents: payment - interest, feesCents: 0, balloonCents: 0,
      totalCents: payment, closingBalanceCents: closing })
    opening = closing
  }
  return { rows, closingBalanceCents: opening, adjustmentCents: opening - original }
}
