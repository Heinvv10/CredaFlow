import { sastCalendarDate } from "@/lib/date/sast"
import { addMonthsClamped, toDayNumber } from "./dates"
import { dealStartDate } from "./deal-structure"

/**
 * The planned start a test passes to the signing prepare step for a deal whose first instalment is `firstDueDate`: the deal's own
 * start (dealStartDate: a month before the first instalment), or today if that day has gone.
 *
 * The fixtures put the first instalment a month on from today (addMonthsClamped(today, 1)), so on a month-end day the start a month
 * before it is not today: 31 Oct + 1 month clamps to 30 Nov, and a month before 30 Nov is 30 Oct. The prepare step refuses a start in
 * the past ("may not be in the past"), so every test that signed a deal on dealStartDate(first) failed on the 29th to the 31st. Today
 * is not later than the day the term was approved from, so the prepared term is no longer than the approved one.
 */
export function plannedStartFor(firstDueDate: string, today: string = sastCalendarDate(new Date())): string {
  const start = dealStartDate(firstDueDate)
  return start < today ? today : start
}

/**
 * The days `backdateLease` moves a lease back for `months` months: the days between the lease's own start and the same day `months`
 * months on (addMonthsClamped). The fixtures book a lease starting today with the first rental a month on; moving it back whole
 * months (a Postgres interval) does not round-trip on the 29th to the 31st (31 Oct + 1 month clamps to 30 Nov, a month back is 30 Oct),
 * so the lease ended a day early. Moving by the day gap lands the first rental on the start date exactly.
 */
export function leaseShiftDays(startDate: string, months: number): number {
  return toDayNumber(addMonthsClamped(startDate, months)) - toDayNumber(startDate)
}
