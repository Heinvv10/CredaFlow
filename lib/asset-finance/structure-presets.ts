// Period-weight generators for the structure solver (DESIGN.md D6). Each
// returns one weight per period: 0 = skip, 1 = normal, n = a multiple of the
// base instalment. Calendar-aware presets take `startMonth`, the calendar month
// (1-12) of the FIRST due date; period i then falls in month startMonth + i.

export interface WeightStep {
  fromPeriod: number // 0-based period from which `weight` applies
  weight: number
}

function assertTerm(n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n: must be a positive whole number of periods")
}

function assertMonth(month: number, label: string): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError(`${label}: must be a month 1-12`)
}

function assertWeight(weight: number, label: string): void {
  if (!Number.isFinite(weight) || weight < 0) throw new RangeError(`${label}: must be a finite number >= 0`)
}

/** Calendar month (1-12) of period i when period 0 falls in startMonth. */
function monthOf(startMonth: number, period: number): number {
  return ((startMonth - 1 + period) % 12) + 1
}

/** n equal instalments. */
export function monthly(n: number): number[] {
  assertTerm(n)
  return new Array<number>(n).fill(1)
}

/** seasonWeight in the season's calendar months, offWeight in all others. */
export function annualSeasonal(
  n: number,
  startMonth: number,
  seasonMonths: number[],
  seasonWeight: number,
  offWeight: number,
): number[] {
  assertTerm(n)
  assertMonth(startMonth, "startMonth")
  seasonMonths.forEach((month, i) => assertMonth(month, `seasonMonths[${i}]`))
  assertWeight(seasonWeight, "seasonWeight")
  assertWeight(offWeight, "offWeight")
  return Array.from({ length: n }, (_, i) => (seasonMonths.includes(monthOf(startMonth, i)) ? seasonWeight : offWeight))
}

/**
 * Weight 1 in the two calendar months, 0 in every other. `startMonth` is an
 * addition to the two-month list: without it a period cannot be placed in the
 * calendar.
 */
export function biannual(n: number, months: [number, number], startMonth: number): number[] {
  assertTerm(n)
  assertMonth(startMonth, "startMonth")
  months.forEach((month, i) => assertMonth(month, `months[${i}]`))
  if (months[0] === months[1]) throw new RangeError("months: must be two different months")
  return Array.from({ length: n }, (_, i) => (months.includes(monthOf(startMonth, i)) ? 1 : 0))
}

/** The first `skipFirst` periods pay nothing, the rest weight 1. */
export function skipN(n: number, skipFirst: number): number[] {
  assertTerm(n)
  if (!Number.isInteger(skipFirst) || skipFirst < 0 || skipFirst >= n) {
    throw new RangeError("skipFirst: must be a whole number from 0 to n - 1")
  }
  return Array.from({ length: n }, (_, i) => (i < skipFirst ? 0 : 1))
}

/**
 * Weight 1 until the first step, then each step's weight from its fromPeriod
 * until the next step. Steps must be strictly ascending and within the term.
 */
export function stepUp(n: number, steps: WeightStep[]): number[] {
  assertTerm(n)
  steps.forEach((step, i) => {
    if (!Number.isInteger(step.fromPeriod) || step.fromPeriod < 0 || step.fromPeriod >= n) {
      throw new RangeError(`steps[${i}].fromPeriod: must be a period of the term`)
    }
    if (i > 0 && step.fromPeriod <= steps[i - 1].fromPeriod) {
      throw new RangeError("steps: fromPeriod must be strictly ascending")
    }
    assertWeight(step.weight, `steps[${i}].weight`)
  })
  return Array.from({ length: n }, (_, i) => {
    let weight = 1
    for (const step of steps) if (step.fromPeriod <= i) weight = step.weight
    return weight
  })
}
