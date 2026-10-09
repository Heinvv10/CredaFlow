// Calendar arithmetic on day numbers: days since 1970-01-01, as returned by
// sastCalendarDay (lib/loan/settlement.ts).

const MS_PER_DAY = 86_400_000

/** YYYY-MM-DD */
export const isoDay = (day: number) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
export const dayOfMonth = (day: number) => new Date(day * MS_PER_DAY).getUTCDate()
export function daysInMonth(day: number): number {
  const date = new Date(day * MS_PER_DAY)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
}
export const isLastDayOfMonth = (day: number) => dayOfMonth(day) === daysInMonth(day)
