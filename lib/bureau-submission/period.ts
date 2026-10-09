import { sastCalendarDate, sastDayNumberStart, sastParts } from "@/lib/date/sast"

// A bureau period is a SAST calendar day, carried as `YYYY-MM-DD`: the month
// end for a monthly file, the transaction date for a daily one.

export type Day = string

export function isDay(value: string | null | undefined): value is Day {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Midday SAST on the day: the instant every as-at helper is asked about. */
export const dayAsOf = (day: Day) => new Date(`${day}T10:00:00.000Z`)
/** SAST midnight at the start of the day. */
export const dayStart = (day: Day) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() - 2 * 3_600_000)
/** SAST midnight at the END of the day: the first instant after the period. */
export const dayEnd = (day: Day) => new Date(dayStart(day).getTime() + 86_400_000)
/** The value of a `@db.Date` column for the day. */
export const dayToDbDate = (day: Day) => new Date(`${day}T00:00:00.000Z`)
export const dbDateToDay = (date: Date): Day => date.toISOString().slice(0, 10)
/** The SAST calendar day an instant falls on. */
export const dayOf = (instant: Date): Day => sastCalendarDate(instant)
export const monthStartOf = (day: Day): Day => `${day.slice(0, 8)}01`
export const compact = (day: Day) => day.replaceAll("-", "")

/** The last day of the month before the one `now` falls in (SAST). */
export function previousMonthEnd(now: Date): Day {
  const { year, month } = sastParts(now)
  return dayOf(sastDayNumberStart(year, month, 0))
}

/** The SAST day before the one `now` falls in. */
export function previousDay(now: Date): Day {
  const { year, month, day } = sastParts(now)
  return dayOf(sastDayNumberStart(year, month, day - 1))
}

export function isMonthEnd(day: Day): boolean {
  return dayOf(dayEnd(day)).slice(8) === "01"
}
