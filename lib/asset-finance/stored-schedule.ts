/**
 * Reads a stored asset-finance schedule (the representation in
 * ./schedule-records.ts) back into solver rows for repriceTail. Pure.
 *
 * SETTLED AND PENDING. A row is PENDING when its status is PENDING and nothing
 * is paid against it; every other row is settled history. The pending rows are
 * everything after the last settled row. A skip row (totalDue 0) is never
 * paid, so it stays PENDING forever: behind a settled row it counts as settled
 * history; any other PENDING row behind a settled one is a gap
 * (schedule_not_contiguous), as is an installmentNo that is not index + 1.
 *
 * THE BALANCE. The stored rows do not hold the capitalised interest of a row
 * whose payment is below its interest (stored principal 0), so the balance
 * after the last settled row is rebuilt from the pending rows, which one solve
 * produced under the contract's current rate path:
 *   after the last row's regular payment the balance is the balloon;
 *   walking back, a row with stored principal p > 0 opened at (after + p);
 *   a row with stored principal 0 opened at the one integer x with
 *   x + interest(x) = after + payment (x + round(x × rate-days / 365) is
 *   strictly increasing in x, so x is unique).
 * The rows are then re-solved forward from that balance under the same rate
 * path and must reproduce every stored pending row exactly (interest,
 * principal, total) and close at 0; anything else (a row edited by hand, a
 * path that is not the one the rows were solved under) is refused as
 * unsupported_schedule rather than repriced from a guess.
 *
 * In the solver rows returned, the pending rows are exact (balances included);
 * settled rows carry their index, due date and stored amounts only (weight 0,
 * balances 0): repriceTail reads nothing else from them.
 */
import { sastCalendarDate } from "@/lib/date/sast"
import { DAY_COUNT_BASIS, periodInterest } from "./amortise"
import { toDayNumber } from "./dates"
import { rateDaySum, rateSegments } from "./rates"
import { deriveWeights, modalPositive, toScheduleRecord, type ScheduleRecordAmounts } from "./schedule-records"
import type { RatePoint, ScheduleRow } from "./types"

export type StoredScheduleError = "no_pending_rows" | "schedule_not_contiguous" | "unsupported_schedule"

export interface StoredScheduleRow extends ScheduleRecordAmounts {
  id: string
  status: string
  totalPaid: number
}

export interface StoredScheduleInput {
  stored: StoredScheduleRow[] // ordered by installmentNo
  balloonCents: number
  recordedBaseCents: number | null // latest ContractRate.newInstalmentCents, if any
  ratePath: RatePoint[] // the contract rate path the pending rows were solved under
  startDate: string // contract start: row 1's period runs from the day after it
}

export interface StoredSchedule {
  rows: ScheduleRow[] // the full schedule in solver form, index = installmentNo − 1
  paidThroughIndex: number // last settled row, -1 if none
  capitalOutstandingCents: number // balance after the last settled row, capitalised interest included
  referenceInstalmentCents: number // R in deriveWeights
}

/** A pending row: PENDING and nothing paid against it. Every other row is settled history. */
const isPending = (row: StoredScheduleRow): boolean => row.status === "PENDING" && row.totalPaid === 0

/** The opening balance x with x + interest(x) = target, or null when no integer has it. */
function openingBefore(target: number, rateDays: number): number | null {
  const guess = Math.round(target / (1 + rateDays / DAY_COUNT_BASIS))
  for (let x = Math.max(0, guess - 2); x <= guess + 2; x++) {
    if (x + periodInterest(x, rateDays) === target) return x
  }
  return null
}

const sameAmounts = (a: ScheduleRecordAmounts, b: ScheduleRecordAmounts): boolean =>
  a.principalDue === b.principalDue && a.interestDue === b.interestDue && a.totalDue === b.totalDue
  && a.feesDue === b.feesDue && a.creditLifePremiumDue === b.creditLifePremiumDue

export function storedScheduleForReprice(input: StoredScheduleInput): StoredSchedule | { error: StoredScheduleError } {
  const { stored, balloonCents } = input
  if (!stored.every((row, i) => row.installmentNo === i + 1)) return { error: "schedule_not_contiguous" }
  let lastSettled = -1
  stored.forEach((row, i) => {
    if (!isPending(row)) lastSettled = i
  })
  const first = lastSettled + 1
  if (first === stored.length) return { error: "no_pending_rows" }
  if (stored.slice(0, Math.max(0, lastSettled)).some((row) => isPending(row) && row.totalDue > 0)) return { error: "schedule_not_contiguous" }

  const last = stored.length - 1
  const balloonOf = (i: number) => (i === last ? balloonCents : 0)
  const payments = stored.map((row, i) => row.totalDue - balloonOf(i))
  const tail = stored.slice(first)
  if (tail.some((row, k) => payments[first + k] < 0 || row.principalDue < balloonOf(first + k))) {
    return { error: "unsupported_schedule" }
  }

  // Σ rate(d) over each pending period: (previous due date, due date].
  const dueDays = stored.map((row) => toDayNumber(sastCalendarDate(row.dueDate)))
  const startDay = toDayNumber(input.startDate, "startDate")
  const segments = rateSegments(input.ratePath, startDay)
  const rateDays = dueDays.map((day, i) => (i < first ? 0 : rateDaySum(segments, i === 0 ? startDay : dueDays[i - 1], day)))

  let after = balloonCents
  for (let i = last; i >= first; i--) {
    const principal = stored[i].principalDue - balloonOf(i)
    const opening = principal > 0 ? after + principal : openingBefore(after + payments[i], rateDays[i])
    if (opening === null) return { error: "unsupported_schedule" }
    after = opening
  }
  const capitalOutstandingCents = after

  const regulars = payments.slice(first)
  const referenceInstalmentCents =
    input.recordedBaseCents ?? modalPositive(regulars.slice(0, -1)) ?? regulars[regulars.length - 1]
  if (!(referenceInstalmentCents > 0)) return { error: "unsupported_schedule" }
  const weights = deriveWeights(regulars, referenceInstalmentCents, stored.length)

  const rows: ScheduleRow[] = []
  let opening = capitalOutstandingCents
  for (let i = 0; i <= last; i++) {
    const row = stored[i]
    const dueDate = sastCalendarDate(row.dueDate)
    if (i < first) {
      rows.push({
        index: i, dueDate, weight: 0, openingBalanceCents: 0, interestCents: row.interestDue,
        principalCents: row.principalDue - balloonOf(i), feesCents: row.feesDue, balloonCents: balloonOf(i),
        totalCents: row.totalDue, closingBalanceCents: 0,
      })
      continue
    }
    const interest = periodInterest(opening, rateDays[i])
    const principal = payments[i] - interest
    const closing = opening - principal - balloonOf(i)
    const solverRow: ScheduleRow = {
      index: i, dueDate, weight: weights[i - first], openingBalanceCents: opening, interestCents: interest,
      principalCents: principal, feesCents: 0, balloonCents: balloonOf(i), totalCents: row.totalDue, closingBalanceCents: closing,
    }
    if (!sameAmounts(toScheduleRecord(solverRow), row)) return { error: "unsupported_schedule" }
    rows.push(solverRow)
    opening = closing
  }
  if (opening !== 0) return { error: "unsupported_schedule" }

  return { rows, paidThroughIndex: first - 1, capitalOutstandingCents, referenceInstalmentCents }
}
