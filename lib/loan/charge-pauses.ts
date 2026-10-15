import { sastCalendarDay } from "@/lib/loan/settlement"

/**
 * A window in which no default interest, fee or charge accrues or posts, both
 * ends inclusive SAST calendar days (a recovery's charge freeze,
 * lib/asset-finance/recovery-deadline.ts). Receipts are still allocated.
 */
export interface ChargePause {
  from: Date
  until: Date
}

/**
 * `chargeable` minus the paused days. With no pauses it returns `chargeable`
 * itself, so an engine without pauses behaves exactly as before.
 */
export function withoutPausedDays(
  chargeable: (day: number) => boolean,
  pauses: ChargePause[] | undefined,
): (day: number) => boolean {
  if (!pauses || pauses.length === 0) return chargeable
  const windows = pauses.map((pause) => {
    const from = sastCalendarDay(pause.from)
    const until = sastCalendarDay(pause.until)
    if (!Number.isFinite(from) || !Number.isFinite(until) || until < from) {
      throw new RangeError("A charge pause must end on or after the day it starts")
    }
    return { from, until }
  })
  return (day) => chargeable(day) && !windows.some((window) => day >= window.from && day <= window.until)
}
