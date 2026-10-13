/**
 * The bridge between the solver's ScheduleRow and an asset-finance loan's
 * RepaymentSchedule rows. Pure: no database, no clock.
 *
 * STORAGE CONVENTION (booking writes with toScheduleRecord; repricing reads it
 * back with storedScheduleForReprice, so the two must agree):
 *   installmentNo = index + 1
 *   dueDate       = SAST midnight of the row's calendar due date
 *   principalDue  = principalCents + balloonCents (the balloon is capital, so
 *                   Σ principalDue over the schedule is the financed amount)
 *   interestDue   = interestCents; feesDue = feesCents (0 in slice 1);
 *   creditLifePremiumDue = 0; totalDue = totalCents
 *
 * WEIGHTS ARE NOT STORED. RepaymentSchedule has no weight column and the
 * planned DealStructure (DESIGN.md "New data") does not exist yet, so a
 * pending row's weight is derived from what it pays:
 *   regular_i = totalDue_i − (balloon on the last row)      (= round(B × w_i))
 *   weight_i  = regular_i / R
 * R is the base instalment the rows were solved with when it is recorded (the
 * latest ContractRate.newInstalmentCents), else the most common positive
 * regular payment of the pending non-final rows (the smallest on a tie).
 * The solve is invariant to scaling every weight by one constant, so an R that
 * is a multiple of the true B (e.g. a seasonal schedule whose most common
 * payment is the off-season 0.5 × B) yields the same payments; only the
 * recorded "base instalment" is then in that scale.
 * round(B × w) loses up to half a cent, so the raw ratio can be off by
 * 0.5 / R. A weight is therefore snapped to 4 decimals when the snapped value
 * reproduces the stored payment: exactly (round(R × w) = regular) on a regular
 * row, and within one cent per schedule row on the final row, which also
 * carries the solver's rounding residue. A weight that does not snap keeps
 * the raw ratio; the re-solved payments then match the intended pattern to
 * within a cent per row, and the balance still lands exactly on the balloon.
 *
 * A VAT-deferral lump is indistinguishable from a heavy weight here: see the
 * PARTIAL note in ./reprice-loan.ts.
 */
import { SAST_OFFSET_MS, sastCalendarDate } from "@/lib/date/sast"
import { toDayNumber } from "./dates"
import type { ScheduleRow } from "./types"

const MS_PER_DAY = 86_400_000
const WEIGHT_SCALE = 10_000 // weights snap to 4 decimals

export interface ScheduleRecordAmounts {
  installmentNo: number
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  creditLifePremiumDue: number
  totalDue: number
}

export interface StoredScheduleRow extends ScheduleRecordAmounts {
  id: string
  status: string
  totalPaid: number
}

/** SAST midnight of a calendar date, the instant asset-finance due dates are stored at. */
export function dueDateInstant(iso: string): Date {
  return new Date(toDayNumber(iso, "dueDate") * MS_PER_DAY - SAST_OFFSET_MS)
}

export function toScheduleRecord(row: ScheduleRow): ScheduleRecordAmounts {
  return {
    installmentNo: row.index + 1,
    dueDate: dueDateInstant(row.dueDate),
    principalDue: row.principalCents + row.balloonCents,
    interestDue: row.interestCents,
    feesDue: row.feesCents,
    creditLifePremiumDue: 0,
    totalDue: row.totalCents,
  }
}

/** The most common positive value, the smallest on a tie; null when there is none. */
export function modalPositive(values: number[]): number | null {
  const counts = new Map<number, number>()
  for (const value of values) if (value > 0) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: number | null = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value
      bestCount = count
    }
  }
  return best
}

/**
 * Weights for `regulars` (one regular payment per pending row, the final row
 * last) against reference instalment `referenceCents`; the rule is in the
 * header. `finalToleranceCents` bounds the final row's rounding residue.
 */
export function deriveWeights(regulars: number[], referenceCents: number, finalToleranceCents: number): number[] {
  if (!Number.isSafeInteger(referenceCents) || referenceCents <= 0) {
    throw new RangeError("referenceCents: must be a positive integer number of cents")
  }
  const last = regulars.length - 1
  return regulars.map((regular, i) => {
    const raw = regular / referenceCents
    const snapped = Math.round(raw * WEIGHT_SCALE) / WEIGHT_SCALE
    const reproduces = i === last
      ? Math.abs(referenceCents * snapped - regular) <= finalToleranceCents
      : Math.round(referenceCents * snapped) === regular
    return reproduces ? snapped : raw
  })
}

export type StoredScheduleError = "no_pending_rows" | "schedule_not_contiguous" | "unsupported_schedule"

export interface StoredSchedule {
  rows: ScheduleRow[] // the full schedule in solver form; weights only on pending rows
  paidThroughIndex: number // last row that is not PENDING, -1 if none
  capitalOutstandingCents: number // Σ pending principalDue: the balance after the last non-pending row
  referenceInstalmentCents: number // R in the header
}

/** A pending row: PENDING and nothing paid against it. Every other row is settled history. */
const isPending = (row: StoredScheduleRow): boolean => row.status === "PENDING" && row.totalPaid === 0

/**
 * Reads a stored asset-finance schedule back into solver rows for
 * repriceRemaining. `stored` must be ordered by installmentNo; the pending
 * rows must be one unbroken tail and carry no fees or credit-life premium
 * (they would be lost in the re-solve).
 */
export function storedScheduleForReprice(
  stored: StoredScheduleRow[],
  balloonCents: number,
  recordedBaseCents: number | null,
): StoredSchedule | { error: StoredScheduleError } {
  const firstPending = stored.findIndex(isPending)
  if (firstPending < 0) return { error: "no_pending_rows" }
  const tail = stored.slice(firstPending)
  if (!tail.every(isPending)) return { error: "schedule_not_contiguous" }
  if (tail.some((row) => row.feesDue !== 0 || row.creditLifePremiumDue !== 0)) return { error: "unsupported_schedule" }

  const last = stored.length - 1
  const regulars = tail.map((row, i) => row.totalDue - (firstPending + i === last ? balloonCents : 0))
  const referenceInstalmentCents =
    recordedBaseCents ?? modalPositive(regulars.slice(0, -1)) ?? regulars[regulars.length - 1]
  if (!(referenceInstalmentCents > 0)) return { error: "unsupported_schedule" }
  const weights = deriveWeights(regulars, referenceInstalmentCents, stored.length)

  let opening = stored.reduce((sum, row) => sum + row.principalDue, 0)
  const rows = stored.map((row, i): ScheduleRow => {
    const balloon = i === last ? balloonCents : 0
    const closing = opening - row.principalDue
    const solverRow: ScheduleRow = {
      index: i,
      dueDate: sastCalendarDate(row.dueDate),
      weight: i >= firstPending ? weights[i - firstPending] : 0, // settled rows: not read by the solver
      openingBalanceCents: opening,
      interestCents: row.interestDue,
      principalCents: row.principalDue - balloon,
      feesCents: row.feesDue,
      balloonCents: balloon,
      totalCents: row.totalDue,
      closingBalanceCents: closing,
    }
    opening = closing
    return solverRow
  })
  return {
    rows,
    paidThroughIndex: firstPending - 1,
    capitalOutstandingCents: tail.reduce((sum, row) => sum + row.principalDue, 0),
    referenceInstalmentCents,
  }
}
