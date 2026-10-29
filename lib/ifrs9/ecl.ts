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

const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000)

/**
 * Interest earned since the last due date on the next instalment, pro rata by
 * day, less what was already paid ahead on that instalment. Not yet in the
 * ledger (income is booked when an instalment falls due); memo for EAD.
 */
export function accruedInterestCents(rows: readonly ScheduleRow[], runDate: string, startDate: string): number {
  const index = rows.findIndex((row) => row.dueDate > runDate)
  if (index < 0) return 0
  const next = rows[index]
  const from = index === 0 ? startDate : rows[index - 1].dueDate
  const period = dayNumber(next.dueDate) - dayNumber(from)
  const elapsed = Math.min(Math.max(dayNumber(runDate) - dayNumber(from), 0), period)
  if (period <= 0) return 0
  const earned = Math.round((next.interestDue * elapsed) / period)
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

/** What the lender is exposed to and has recognised: interest in suspense is not an asset, so it is not provisioned. */
export function exposureAtDefault(x: ExposureInputs): number {
  const gross = x.outstandingPrincipalCents + x.unpaidInterestCents + x.unpaidFeesCents + x.chargesOutstandingCents + x.accruedInterestCents
  return Math.max(gross - x.suspendedInterestCents - x.suspendedDefaultInterestCents, 0)
}
