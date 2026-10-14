// Calendar-date arithmetic for the structure solver. A date is an ISO
// "YYYY-MM-DD" string or a day number (whole days since 1970-01-01). Every
// computation is UTC; nothing here reads the local time zone or the clock.

const MS_PER_DAY = 86_400_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

interface CalendarDate {
  year: number
  month: number // 1-12
  day: number // 1-31
}

function parts(iso: string, label: string): CalendarDate {
  const match = ISO_DATE.exec(iso)
  if (!match) throw new RangeError(`${label}: expected YYYY-MM-DD, got "${iso}"`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`${label}: "${iso}" is not a calendar date`)
  }
  return { year, month, day }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Day number of an ISO date; throws RangeError for anything not a real date. */
export function toDayNumber(iso: string, label = "date"): number {
  const { year, month, day } = parts(iso, label)
  return Date.UTC(year, month - 1, day) / MS_PER_DAY
}

export function fromDayNumber(dayNumber: number): string {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10)
}

/**
 * `iso` moved forward by `months` calendar months, keeping the day of month of
 * `iso` and clamping it to the last day of a shorter month. Always computed
 * from the anchor, never chained, so 31 Jan → 28/29 Feb → 31 Mar.
 */
export function addMonthsClamped(iso: string, months: number): string {
  const { year, month, day } = parts(iso, "date")
  const zeroBased = month - 1 + months
  const targetYear = year + Math.floor(zeroBased / 12)
  const targetMonth = (((zeroBased % 12) + 12) % 12) + 1
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth))
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`
}

// Postgres DATE columns (rate and tax-document dates) are read and written by
// Prisma as UTC midnight of the calendar day; these two convert at that
// boundary. (A schedule due date is a timestamp at SAST midnight instead: see
// dueDateInstant in ./schedule-records.ts.)

/** The Date Prisma uses for a DATE column holding calendar day `iso`; RangeError if `iso` is not a date. */
export function dbDate(iso: string, label = "date"): Date {
  return new Date(toDayNumber(iso, label) * MS_PER_DAY)
}

/** The calendar day a DATE column read through Prisma holds. */
export function isoOfDbDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}
