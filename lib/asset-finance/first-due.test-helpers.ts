import { describe, it } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { addMonthsClamped } from "./dates"
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
 * Whether today is a day on which a month on and a month back do not round-trip (the 29th to the 31st): addMonthsClamped(today, 1) is a
 * day short of the same day next month, and a month before THAT is not today. The lease servicing suites book a lease whose first rental
 * is a month on, then move its dates back whole months (`backdateLease`, a Postgres interval) so that its term ends today; on these days
 * it ends the day before, and a claim, a reading or an inspection today is refused ("The lease ended on ...: no claims after it").
 * Those suites do not run on these days (a follow-up: move the lease by the days its own dates are apart, not by whole months).
 */
export function monthEndClamps(today: string = sastCalendarDate(new Date())): boolean {
  return addMonthsClamped(addMonthsClamped(today, 1), -1) !== today
}

/**
 * Call next to a lease servicing suite that does not run on a month-end clamp day (`RUN && !monthEndClamps()`): on such a day, when the
 * suite was asked to run, it registers a skipped entry that says why, so the report names the reason instead of a bare skip.
 */
export function reportMonthEndSkip(suiteName: string, requested: boolean): void {
  if (!requested || !monthEndClamps()) return
  describe.skip(`${suiteName}: skipped on a month-end clamp day (the 29th to the 31st): a lease moved back whole months ends a day early; see monthEndClamps in first-due.test-helpers.ts`, () => {
    it("is not run today", () => undefined)
  })
}
