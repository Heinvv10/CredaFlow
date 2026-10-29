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

/**
 * The month a MONTHLY run stands for: this month, or - when the month-end run was
 * missed - last month, for the first five days of this one. The position is
 * always as at the run date; the later the make-up, the less it is the month-end
 * position, and the run records its own date.
 */
export function resolveMonthlyPeriod(today: string, requested?: string): { ok: true; periodKey: string } | { ok: false; error: string } {
  const current = today.slice(0, 7)
  if (requested === undefined || requested === current) return { ok: true, periodKey: current }
  if (requested === previousMonthKey(current) && Number(today.slice(8, 10)) <= 5) return { ok: true, periodKey: requested }
  return { ok: false, error: `A monthly run is for ${current}, or for ${previousMonthKey(current)} during the first five days of ${current}` }
}
