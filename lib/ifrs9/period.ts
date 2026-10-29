/** Calendar helpers for the monthly run; dates are SAST calendar dates, yyyy-mm-dd. */

const DAY_MS = 86_400_000

export function isLastDayOfMonth(iso: string): boolean {
  const tomorrow = new Date(Date.parse(`${iso}T00:00:00Z`) + DAY_MS).toISOString()
  return tomorrow.slice(0, 7) !== iso.slice(0, 7)
}

export function periodEndDate(periodKey: string): string {
  const [y, m] = periodKey.split("-").map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

export const previousMonthKey = (periodKey: string): string => {
  const [y, m] = periodKey.split("-").map(Number)
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7)
}

/**
 * The month the nightly job should make a MONTHLY run for today, or null: this month on its last day, and
 * last month during the first five days of this one (the retry for a tenant whose month-end run failed).
 */
export function monthlyRunTarget(today: string): string | null {
  if (isLastDayOfMonth(today)) return today.slice(0, 7)
  return Number(today.slice(8, 10)) <= 5 ? previousMonthKey(today.slice(0, 7)) : null
}

export interface MonthlyInstants {
  /** The month's last day, yyyy-mm-dd: the day the run describes, whenever it is made. */
  runDate: string
  /** The instant the position is worked out as at: the end of that day (SAST). */
  runAt: Date
  /** After that day the paid amounts are rebuilt from receipts live before this instant; null on the day itself. */
  receiptsBefore: Date | null
}

/** A MONTHLY run is the month-end position even when made later (a make-up, late or superseding run). */
export function monthlyInstants(periodKey: string, today: string): MonthlyInstants {
  const runDate = periodEndDate(periodKey)
  const nextMidnight = new Date(new Date(`${runDate}T00:00:00+02:00`).getTime() + DAY_MS)
  return { runDate, runAt: new Date(`${runDate}T23:59:00+02:00`), receiptsBefore: runDate < today ? nextMidnight : null }
}
