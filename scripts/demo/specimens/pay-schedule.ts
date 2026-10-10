/**
 * Which pay dates and statement period a persona's specimens show.
 *
 * Everything is relative to an `asOf` date (the day the documents are meant to
 * be uploaded), so a re-bake under a different simulated date produces
 * documents that are recent relative to THAT date. Dates are plain calendar
 * dates handled in UTC — no time of day is ever printed.
 */

export interface CalendarDate {
  year: number
  /** 1–12 */
  month: number
  day: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export function parseIsoDate(iso: string): CalendarDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new Error(`expected YYYY-MM-DD, got "${iso}"`)
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

export function isoDate(d: CalendarDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
}

/** "25 Sep 2026" */
export function printDate(d: CalendarDate): string {
  return `${String(d.day).padStart(2, '0')} ${MONTHS[d.month - 1]} ${d.year}`
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function compare(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 }
}

/**
 * The pay date in a month: the configured day clamped to the month's length,
 * moved back to the Friday when it falls on a weekend — how SA payroll runs.
 */
export function payDateIn(year: number, month: number, salaryDay: number): CalendarDate {
  const day = Math.min(salaryDay, daysInMonth(year, month))
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const back = weekday === 6 ? 1 : weekday === 0 ? 2 : 0
  return { year, month, day: day - back }
}

/** The three most recent pay dates on or before `asOf`, oldest first. */
export function lastThreePayDates(asOf: CalendarDate, salaryDay: number): CalendarDate[] {
  const dates: CalendarDate[] = []
  for (let back = 0; dates.length < 3; back++) {
    const { year, month } = addMonths(asOf.year, asOf.month, -back)
    const pay = payDateIn(year, month, salaryDay)
    if (compare(pay, asOf) <= 0) dates.unshift(pay)
  }
  return dates
}

/** First and last day of a pay date's month — the payslip's period. */
export function payPeriod(pay: CalendarDate): { start: CalendarDate; end: CalendarDate } {
  return {
    start: { year: pay.year, month: pay.month, day: 1 },
    end: { year: pay.year, month: pay.month, day: daysInMonth(pay.year, pay.month) },
  }
}

/**
 * Statement period covering the three pay months, ending no later than asOf.
 */
export function statementPeriod(payDates: readonly CalendarDate[], asOf: CalendarDate): { start: CalendarDate; end: CalendarDate } {
  const first = payDates[0]
  const last = payDates[payDates.length - 1]
  if (!first || !last) throw new Error('statementPeriod needs pay dates')
  const end = payPeriod(last).end
  return { start: payPeriod(first).start, end: compare(end, asOf) > 0 ? asOf : end }
}

/** Months of the SA tax year (March–February) up to and including `pay`. */
export function taxYearMonthsTo(pay: CalendarDate, employmentStart: CalendarDate): number {
  const taxYearStartYear = pay.month >= 3 ? pay.year : pay.year - 1
  const start = compare(employmentStart, { year: taxYearStartYear, month: 3, day: 1 }) > 0
    ? employmentStart
    : { year: taxYearStartYear, month: 3, day: 1 }
  return (pay.year - start.year) * 12 + (pay.month - start.month) + 1
}

export function sastToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date())
}
