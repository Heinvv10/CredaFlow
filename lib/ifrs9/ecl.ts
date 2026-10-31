/**
 * Exposure at default and expected credit loss. Pure; integer cents and basis points.
 *
 *   ECL = EAD x PD x LGD
 *
 * PD is the 12-month PD in Stage 1 and the lifetime PD in Stages 2 and 3 (the
 * parameter table holds the figure for each stage as the lender set it). No
 * discounting and no forward-looking overlay: a lender folds those into its PD
 * and LGD figures.
 */
import { evenly } from "@/lib/product-engine/evenly"

export interface ScheduleRow {
  /** SAST calendar date, yyyy-mm-dd. */
  dueDate: string
  interestDue: number
  feesDue: number
  principalDue: number
  totalDue: number
  totalPaid: number
}

// BigInt() calls, not literals: the TypeScript target predates ES2020.
const BPS = BigInt(10_000)
const TWO = BigInt(2)

function assertBps(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new RangeError(`${name} must be a whole number of basis points, 0-10000`)
}

/** EAD x PD x LGD to the nearest cent, half up. BigInt: the product exceeds 2^53 for a large book. */
export function eclCents(eadCents: number, pdBps: number, lgdBps: number): number {
  if (!Number.isSafeInteger(eadCents) || eadCents < 0) throw new RangeError("EAD must be a non-negative whole number of cents")
  assertBps("PD", pdBps)
  assertBps("LGD", lgdBps)
  const scale = BPS * BPS
  const numerator = BigInt(eadCents) * BigInt(pdBps) * BigInt(lgdBps)
  return Number((numerator * TWO + scale) / (scale * TWO))
}

/** `amount` x `numerator` / `denominator` to the nearest cent, half up (BigInt: the product can pass 2^53). Zero when the denominator is. */
export function proportionCents(amount: number, numerator: number, denominator: number): number {
  for (const [name, value] of [["amount", amount], ["numerator", numerator], ["denominator", denominator]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative whole number of cents`)
  }
  if (denominator === 0) return 0
  const den = BigInt(denominator)
  return Number((BigInt(amount) * BigInt(numerator) * TWO + den) / (den * TWO))
}

/** Interest and fees on instalments due on or before the run date and still unpaid; a receipt pays interest, then fees, then principal. */
export function unpaidScheduleAmounts(rows: readonly ScheduleRow[], runDate: string): { interestCents: number; feesCents: number } {
  let interestCents = 0
  let feesCents = 0
  for (const row of rows) {
    if (row.dueDate > runDate) continue
    interestCents += Math.max(row.interestDue - row.totalPaid, 0)
    feesCents += Math.max(row.feesDue - Math.max(row.totalPaid - row.interestDue, 0), 0)
  }
  return { interestCents, feesCents }
}

/** Contractual interest on instalments falling due from `from` to `to`, both inclusive (yyyy-mm-dd). */
export function interestRaisedBetween(rows: readonly ScheduleRow[], from: string, to: string): number {
  return rows.filter((r) => r.dueDate >= from && r.dueDate <= to).reduce((sum, r) => sum + r.interestDue, 0)
}

const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000)

/**
 * The simple interest a full grace (lib/product-engine) defers: nothing is due for the grace, so no row carries it, but it is
 * earned in the grace. `cents` is spread evenly over the rows that follow (the generator's own split), `endDate` is the day
 * the grace ends (yyyy-mm-dd).
 */
export interface GraceDeferral {
  endDate: string
  cents: number
}

/**
 * Interest earned since the last due date on the next instalment, pro rata by
 * day, less what was already paid ahead on that instalment. Not yet in the
 * ledger (income is booked when an instalment falls due); memo for EAD.
 *
 * A loan with a full grace (`deferral`) earns the deferred interest through the grace, not through the first period after it:
 * by the end of the grace all of it is earned, and what is earned of it and not yet raised in a row is accrued, on top of the
 * own interest of the period running now.
 */
export function accruedInterestCents(rows: readonly ScheduleRow[], runDate: string, startDate: string, deferral?: GraceDeferral): number {
  const index = rows.findIndex((row) => row.dueDate > runDate)
  if (index < 0) return 0
  const next = rows[index]
  const shares = deferral && deferral.cents > 0 ? evenly(deferral.cents, rows.length) : null
  // The period the instalment's own interest runs over: after a full grace it starts when the grace ends.
  const periodStart = index > 0 ? rows[index - 1].dueDate : shares && deferral!.endDate > startDate ? deferral!.endDate : startDate
  const period = dayNumber(next.dueDate) - dayNumber(periodStart)
  const elapsed = Math.min(Math.max(dayNumber(runDate) - dayNumber(periodStart), 0), period)
  if (period <= 0) return 0
  const own = next.interestDue - (shares?.[index] ?? 0)
  let earned = Math.round((own * elapsed) / period)
  if (shares && deferral) {
    const graceDays = dayNumber(deferral.endDate) - dayNumber(startDate)
    const earnedDeferred = graceDays <= 0 ? deferral.cents : Math.round((deferral.cents * Math.min(Math.max(dayNumber(runDate) - dayNumber(startDate), 0), graceDays)) / graceDays)
    const raisedDeferred = rows.slice(0, index).reduce((sum, _row, i) => sum + shares[i]!, 0)
    earned += Math.max(earnedDeferred - raisedDeferred, 0)
  }
  return Math.max(earned - next.totalPaid, 0)
}

export interface ExposureInputs {
  outstandingPrincipalCents: number
  unpaidInterestCents: number
  unpaidFeesCents: number
  /** All default charges owed (Loan.chargesOutstanding while charges are live). */
  chargesOutstandingCents: number
  accruedInterestCents: number
  /** Raised, unpaid contractual interest held in suspense. */
  suspendedInterestCents: number
  /** Default interest owed and held in suspense (part of chargesOutstandingCents). */
  suspendedDefaultInterestCents: number
}

/**
 * What the lender is exposed to. `suspended*` is what is taken out of it: on the full-suspension basis interest in
 * suspense is not a recognised asset, so it is not provisioned. (The net basis keeps exposure gross and passes 0.)
 */
export function exposureAtDefault(x: ExposureInputs): number {
  const gross = x.outstandingPrincipalCents + x.unpaidInterestCents + x.unpaidFeesCents + x.chargesOutstandingCents + x.accruedInterestCents
  return Math.max(gross - x.suspendedInterestCents - x.suspendedDefaultInterestCents, 0)
}
