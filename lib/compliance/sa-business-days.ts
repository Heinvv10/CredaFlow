const SAST_TIME_ZONE = "Africa/Johannesburg"

export function southAfricanCalendarDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError("Calendar time is invalid")
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SAST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value)
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")}`
}

function parseCalendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError("Invalid ISO calendar date")
  }
  const parsed = new Date(`${value}T12:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime())) {
    throw new RangeError("Invalid ISO calendar date")
  }
  return parsed
}

function formatUtcCalendarDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function addCalendarDays(value: string, days: number): string {
  const date = parseCalendarDate(value)
  date.setUTCDate(date.getUTCDate() + days)
  return formatUtcCalendarDate(date)
}

// Gregorian computus (Meeus/Jones/Butcher), used for Good Friday and Family
// Day under the South African Public Holidays Act.
function easterSunday(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function publicHolidayDates(year: number): Set<string> {
  const fixed = [
    `${year}-01-01`,
    `${year}-03-21`,
    `${year}-04-27`,
    `${year}-05-01`,
    `${year}-06-16`,
    `${year}-08-09`,
    `${year}-09-24`,
    `${year}-12-16`,
    `${year}-12-25`,
    `${year}-12-26`,
  ]
  const easter = easterSunday(year)
  const holidays = new Set([
    ...fixed,
    addCalendarDays(easter, -2),
    addCalendarDays(easter, 1),
  ])

  // Historical fallback for legacy evidence created without the database
  // calendar. New legal artifacts use the data-driven PostgreSQL calendar in
  // sa-business-calendar.server.ts, where proclaimed dates can be added
  // without changing application code.
  if (year === 2024) {
    holidays.add("2024-05-29")
  }

  // Section 2(1): when a listed public holiday falls on a Sunday, the
  // following Monday is also a public holiday.
  for (const date of [...holidays]) {
    if (parseCalendarDate(date).getUTCDay() === 0) {
      holidays.add(addCalendarDays(date, 1))
    }
  }
  return holidays
}

export function isSouthAfricanBusinessDate(value: string): boolean {
  const date = parseCalendarDate(value)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  return !publicHolidayDates(date.getUTCFullYear()).has(value)
}

export function addSouthAfricanBusinessDays(
  startDate: string,
  businessDays: number,
): string {
  if (!Number.isSafeInteger(businessDays) || businessDays < 0) {
    throw new RangeError("Business-day count must be a non-negative integer")
  }
  let date = startDate
  let remaining = businessDays
  parseCalendarDate(startDate)
  while (remaining > 0) {
    date = addCalendarDays(date, 1)
    if (isSouthAfricanBusinessDate(date)) remaining -= 1
  }
  return date
}

export function quotationValidUntilDate(
  presentedAt: Date,
  businessDays = 5,
): string {
  if (!Number.isFinite(presentedAt.getTime())) {
    throw new RangeError("Quotation presentation time is invalid")
  }
  return addSouthAfricanBusinessDays(
    southAfricanCalendarDate(presentedAt),
    businessDays,
  )
}

export function quotationIsBindingThroughDate(
  presentedAt: Date,
  at: Date,
  validUntilDate: string,
): boolean {
  if (
    !Number.isFinite(presentedAt.getTime())
    || !Number.isFinite(at.getTime())
    || at.getTime() < presentedAt.getTime()
  ) {
    return false
  }
  try {
    parseCalendarDate(validUntilDate)
  } catch {
    return false
  }
  return southAfricanCalendarDate(at) <= validUntilDate
}

export function quotationIsBindingAt(
  presentedAt: Date,
  at: Date,
  businessDays = 5,
): boolean {
  if (
    !Number.isFinite(presentedAt.getTime())
    || !Number.isFinite(at.getTime())
    || at.getTime() < presentedAt.getTime()
  ) {
    return false
  }
  return southAfricanCalendarDate(at)
    <= quotationValidUntilDate(presentedAt, businessDays)
}

/**
 * Whole SAST calendar days from `from` to `to`, negative if `to` is earlier.
 *
 * This is the payout anchor. A credit agreement's schedule is fixed when the
 * agreement is established, but the consumer's term must run from the day the
 * money actually reaches them — otherwise a payout that lands a day late
 * shortens the credit period while the interest stays at the disclosed figure,
 * which pushes the effective rate above the NCA s103 cap.
 *
 * Counted in whole CALENDAR days, not elapsed milliseconds, for two reasons:
 * a payout later on the same SAST day must shift nothing (that is the ordinary
 * case and it has to stay exactly as it was), and 23:59 to 00:01 across
 * midnight is two minutes of wall clock but a whole day of credit.
 */
export function sastCalendarDaysBetween(from: Date, to: Date): number {
  const startOfSastDay = (value: Date) =>
    Date.parse(`${southAfricanCalendarDate(value)}T00:00:00.000Z`)
  const fromDay = startOfSastDay(from)
  const toDay = startOfSastDay(to)
  if (!Number.isFinite(fromDay) || !Number.isFinite(toDay)) {
    throw new RangeError("Calendar time is invalid")
  }
  return Math.round((toDay - fromDay) / 86_400_000)
}
