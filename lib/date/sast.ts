/**
 * SAST calendar primitives.
 *
 * South Africa is fixed at UTC+02:00 and has observed no daylight saving since
 * 1944, so a SAST wall-clock boundary is pure arithmetic over a constant
 * offset — no tz database, and a result that does not depend on the host's
 * local zone. That last property is the point: the container sets no `TZ`
 * (there is no `ENV TZ` in the Dockerfile, and `instrumentation.ts` passes
 * `timezone: SAST` to every `cron.schedule` precisely because of that), so
 * anything built from local date parts is really built in UTC and lands up to
 * two hours inside the previous South African day.
 *
 * These primitives were factored out of `lib/compliance/quarters.ts`, which
 * had already fought this battle for statutory returns. They live here so the
 * reporting layer can share them rather than grow a second, subtly different
 * `sastParts` — the failure mode that module's own header describes, where
 * three definitions of "Q3" produced three answers on returns filed with two
 * regulators.
 */

/** Fixed SAST offset. A constant, not a lookup, because SA has no DST. */
export const SAST_OFFSET_MS = 2 * 60 * 60 * 1000

/** Wall-clock SAST fields for an instant, read off a shifted UTC clock. */
export function sastParts(instant: Date): {
  year: number
  month: number
  day: number
  /** 0 = Monday. South African lending weeks run Mon–Sun. */
  weekday: number
} {
  const shifted = new Date(instant.getTime() + SAST_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: (shifted.getUTCDay() + 6) % 7,
  }
}

/** The UTC instant of SAST-midnight on the 1st of `month` in `year`. */
export function sastMonthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1) - SAST_OFFSET_MS)
}

/**
 * The UTC instant SAST-midnight falls on for a calendar day. Overflowing day
 * numbers normalise the way `Date.UTC` does, so `sastDayNumberStart(2026, 7, 0)`
 * is the last day of the preceding month — which is what makes "start of the
 * SAST week" a subtraction rather than a special case.
 */
export function sastDayNumberStart(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day) - SAST_OFFSET_MS)
}

/** SAST wall-clock hour (0–23) of an instant. */
export function sastHour(instant: Date): number {
  return new Date(instant.getTime() + SAST_OFFSET_MS).getUTCHours()
}

/** The SAST calendar date an instant falls on, as `yyyy-mm-dd`. */
export function sastCalendarDate(instant: Date): string {
  const { year, month, day } = sastParts(instant)
  return `${year}-${`${month + 1}`.padStart(2, "0")}-${`${day}`.padStart(2, "0")}`
}

/** SAST-midnight at the start of the calendar day containing `instant`. */
export function sastStartOfDay(instant: Date): Date {
  const { year, month, day } = sastParts(instant)
  return sastDayNumberStart(year, month, day)
}
