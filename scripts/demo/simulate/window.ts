/**
 * The simulated window. When it ends today (the default: the bake ends "now")
 * today's business hours have not happened yet, so the last business day
 * whose hours are fully simulated is the one before today.
 */
import { addDays, prevBusinessDay, realToday } from "./dates"
import type { Window } from "./plan"

export function simWindow(start: string, until: string): Window {
  if (until < start) throw new Error(`--until ${until} is before --start ${start}`)
  const today = realToday()
  if (until > today) throw new Error(`--until ${until} is after today (${today}); the bake cannot end in the future`)
  const lastFullDay = until === today ? addDays(until, -1) : until
  return { start, until, lastBusinessDay: prevBusinessDay(lastFullDay) }
}
