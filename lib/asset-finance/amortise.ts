// The amortisation engine shared by solveStructure (a new deal) and
// repriceRemaining (the pending tail of a booked deal). The rules it applies
// are documented on solveStructure in ./structure.ts.
import { toDayNumber } from "./dates"
import { rateDaySum, rateSegments } from "./rates"
import type { RatePoint, ScheduleRow } from "./types"

/** Actual/365 fixed: every year counts 365 days, leap years included. */
export const DAY_COUNT_BASIS = 365
const RATE_SCALE = 1_000_000

export interface AmortisationPeriod {
  dueDate: string
  weight: number
  lumpCents: number // fixed amount paid on top of B × weight (the VAT-deferral lump)
}

export interface AmortisationInput {
  firstIndex: number // contract index of periods[0]
  openingCents: number
  accrualStartDate: string // interest accrues on the days after this date
  periods: AmortisationPeriod[]
  ratePath: RatePoint[]
  balloonCents: number
  /**
   * A lease rental in advance (./lease-pricing.ts): the first period may fall
   * ON the accrual start date. It then spans no days and accrues no interest.
   */
  firstDueOnAccrualStart?: boolean
}

export interface AmortisationResult {
  baseInstalmentCents: number
  rows: ScheduleRow[]
}

/** A period's interest: simple, on its opening balance, rounded half-up once (the rule in ./structure.ts). */
export function periodInterest(openingCents: number, rateDays: number): number {
  const scaledRateDays = Math.round(rateDays * RATE_SCALE)
  const numerator = BigInt(openingCents) * BigInt(scaledRateDays)
  const denominator = BigInt(DAY_COUNT_BASIS * RATE_SCALE)
  const two = BigInt(2)
  return Number((numerator * two + denominator) / (denominator * two))
}

export function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label}: must be a non-negative integer number of cents`)
  }
}

function validatePeriods(periods: AmortisationPeriod[], accrualStartDay: number, firstOnStart: boolean): number[] {
  if (periods.length === 0) throw new RangeError("weights: at least one period is required")
  let weightSum = 0
  let previousDay = accrualStartDay
  const dueDays = periods.map((period, i) => {
    if (!Number.isFinite(period.weight) || period.weight < 0) {
      throw new RangeError(`weights[${i}]: must be a finite number >= 0`)
    }
    assertCents(period.lumpCents, `period ${i} lump`)
    const dueDay = toDayNumber(period.dueDate, `period ${i} due date`)
    const onStart = firstOnStart && i === 0 && dueDay === previousDay
    if (dueDay <= previousDay && !onStart) throw new RangeError(`period ${i}: due date must be after the previous date`)
    previousDay = dueDay
    weightSum += period.weight
    return dueDay
  })
  if (weightSum <= 0) throw new RangeError("weights: must sum to more than 0")
  if (periods[periods.length - 1].weight <= 0) {
    throw new RangeError("weights: the final period must carry an instalment (weight > 0) to absorb the rounding residue")
  }
  return dueDays
}

export function amortise(input: AmortisationInput): AmortisationResult {
  const { periods, balloonCents } = input
  assertCents(input.openingCents, "opening balance")
  assertCents(balloonCents, "balloonCents")
  if (input.openingCents <= 0) throw new RangeError("financed amount: must be more than 0")

  const startDay = toDayNumber(input.accrualStartDate, "accrual start date")
  const dueDays = validatePeriods(periods, startDay, input.firstDueOnAccrualStart === true)
  const segments = rateSegments(input.ratePath, startDay)
  // Σ rate(d) over each period's days (previous due date, this due date].
  const rateDays = dueDays.map((dueDay, i) => rateDaySum(segments, i === 0 ? startDay : dueDays[i - 1], dueDay))

  // Real-valued pass (no rounding): the closing balance is linear in B,
  // closing(B) = atZero − B × perUnitOfBase, solved for closing(B) = balloon.
  // perUnitOfBase has its own recurrence: taking it as closing(0) − closing(1)
  // cancels two ~1e9 numbers and moved B by up to 0.03 cents.
  let atZero = input.openingCents
  let perUnitOfBase = 0
  periods.forEach((period, i) => {
    const growth = 1 + rateDays[i] / DAY_COUNT_BASIS
    atZero = atZero * growth - period.lumpCents
    perUnitOfBase = perUnitOfBase * growth + period.weight
  })
  const realBase = (atZero - balloonCents) / perUnitOfBase
  const baseInstalmentCents = Math.round(realBase)
  if (!(baseInstalmentCents > 0)) throw new RangeError("structure: the solved instalment is not positive")

  // Cents pass: interest rounded once per period, payments round(B × weight).
  const rows: ScheduleRow[] = []
  const last = periods.length - 1
  let opening = input.openingCents
  for (let i = 0; i <= last; i++) {
    const period = periods[i]
    const interest = periodInterest(opening, rateDays[i])
    // The last row absorbs the rounding residue: it pays exactly what leaves
    // the balloon outstanding, instead of round(B × weight).
    const regular = i === last
      ? opening + interest - balloonCents
      : Math.round(baseInstalmentCents * period.weight) + period.lumpCents
    if (regular < 0) throw new RangeError("structure: the final instalment would be negative")
    // Negative when the payment does not cover the interest (a skip or
    // low-weight period): the unpaid interest capitalises into the balance.
    const principal = regular - interest
    const balloon = i === last ? balloonCents : 0
    const closing = opening - principal - balloon
    rows.push({
      index: input.firstIndex + i,
      dueDate: period.dueDate,
      weight: period.weight,
      openingBalanceCents: opening,
      interestCents: interest,
      principalCents: principal,
      feesCents: 0,
      balloonCents: balloon,
      totalCents: principal + interest + balloon,
      closingBalanceCents: closing,
    })
    opening = closing
  }
  return { baseInstalmentCents, rows }
}
