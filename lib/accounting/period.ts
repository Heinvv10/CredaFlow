/**
 * Accounting periods: SAST calendar months keyed "yyyy-mm".
 *
 * A period's journals carry dates inside the period. A money event dated
 * before the period (a backdated receipt captured after its month closed, a
 * reversal of last month's receipt) posts on the period's first day: the closed
 * month is never reopened, and Xero refuses a journal in a locked period.
 */
import { sastCalendarDate, sastMonthStart } from "@/lib/date/sast"

export interface AccountingPeriod {
  key: string
  /** UTC instant of SAST midnight on the 1st. */
  start: Date
  /** Exclusive: SAST midnight on the 1st of the next month. */
  end: Date
  /** yyyy-mm-dd of the first and last SAST calendar days. */
  firstDay: string
  lastDay: string
  label: string
}

const KEY = /^(\d{4})-(0[1-9]|1[0-2])$/
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

export function parsePeriodKey(key: unknown): AccountingPeriod | null {
  if (typeof key !== "string") return null
  const match = KEY.exec(key)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  if (year < 2000 || year > 2100) return null
  const start = sastMonthStart(year, month)
  const end = sastMonthStart(year, month + 1)
  return {
    key,
    start,
    end,
    firstDay: sastCalendarDate(start),
    lastDay: sastCalendarDate(new Date(end.getTime() - 1)),
    label: `${MONTHS[month]} ${year}`,
  }
}

export function periodKeyOf(instant: Date): string {
  return sastCalendarDate(instant).slice(0, 7)
}

export function nextPeriodKey(key: string): string {
  const period = parsePeriodKey(key)
  if (!period) throw new Error(`Invalid period key: ${key}`)
  return periodKeyOf(period.end)
}

/** The journal date for an event that belongs in `period` (it is dated before the period's end). */
export function postingDate(eventDate: Date, period: AccountingPeriod): string {
  return eventDate.getTime() < period.start.getTime() ? period.firstDay : sastCalendarDate(eventDate)
}

/** A month can be closed only once it has ended, so no later event of that month can arrive "late". */
export function periodHasEnded(period: AccountingPeriod, now: Date): boolean {
  return period.end.getTime() <= now.getTime()
}
