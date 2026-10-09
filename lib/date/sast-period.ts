/**
 * SAST calendar period boundaries.
 *
 * Every reporting window in this app is a *South African* calendar window —
 * "this month" means the month a Johannesburg staff member is looking at, not
 * the month the container happens to be in. The container sets no `TZ`
 * (there is no `ENV TZ` in the Dockerfile, and `instrumentation.ts` passes
 * `timezone: SAST` to every `cron.schedule` precisely because of that), so
 * `new Date(y, m, 1)` resolves to **UTC** midnight and lands up to two hours
 * inside the previous SAST day.
 *
 * That is not theoretical. A payment received at 00:32 SAST on 1 August 2026
 * is stored as `2026-07-31T22:32Z`. The payments table renders it in SAST and
 * shows August; a `gte: new Date(2026, 7, 1)` aggregate excluded it and showed
 * July. The same row, in two different months, on the same screen.
 *
 * South Africa is UTC+02:00 all year and has observed no DST since 1944, so a
 * SAST boundary is exactly the instant `${yyyy-mm-dd}T00:00:00+02:00`. That
 * makes every function here pure arithmetic over a fixed offset — no tz
 * database, no `date-fns-tz`, and boundaries that can be asserted to the
 * millisecond in a test.
 *
 * Ranges are half-open: `[start, end)`, filtered with `gte`/`lt` and never
 * `lte`. The previous code built a month end as `new Date(y, m + 1, 0)` — the
 * last day of the month at 00:00:00 — and then filtered `lte`, which silently
 * dropped the whole final day of every month.
 */

import {
  sastCalendarDate,
  sastDayNumberStart,
  sastParts,
} from "@/lib/date/sast"

export { sastCalendarDate }

export const PERIOD_KEYS = [
  "today",
  "this-week",
  "this-month",
  "last-month",
  "this-year",
  "all",
  "custom",
] as const

export type PeriodKey = (typeof PERIOD_KEYS)[number]

export const DEFAULT_PERIOD_KEY: PeriodKey = "this-month"

export interface Period {
  key: PeriodKey
  /** Inclusive lower bound. `null` means unbounded (all time). */
  start: Date | null
  /** EXCLUSIVE upper bound. `null` means "up to now and beyond". */
  end: Date | null
  /** Human label for a card or an export header, e.g. "July 2026". */
  label: string
  /** Echoed back so a custom range can repopulate its own form inputs. */
  from?: string
  to?: string
}

export interface PeriodInput {
  period?: string | string[] | null
  from?: string | string[] | null
  to?: string | string[] | null
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * The instant a SAST calendar day begins, e.g. "2026-08-01" →
 * 2026-07-31T22:00:00Z. Returns `null` for anything that is not a real
 * calendar date, so a caller can fall back rather than emit an `Invalid Date`
 * — a NaN bound makes every Prisma comparison silently match nothing, which
 * reads on screen as "no payments" rather than as an error.
 */
export function sastDayStart(value: string): Date {
  const parsed = parseSastDayStart(value)
  if (!parsed) throw new RangeError(`Not a calendar date: ${value}`)
  return parsed
}

function parseSastDayStart(ymd: unknown): Date | null {
  if (typeof ymd !== "string" || !YMD.test(ymd)) return null
  const at = new Date(`${ymd}T00:00:00.000+02:00`)
  if (Number.isNaN(at.getTime())) return null
  // `new Date("2026-02-31T…")` is rejected by V8, but re-deriving the calendar
  // date closes the gap if any runtime ever rolls it over instead.
  return sastCalendarDate(at) === ymd ? at : null
}

function monthLabel(year: number, month: number): string {
  // Via Date.UTC so an offset month (`month - 1` in January) normalises into
  // the right month of the right year rather than indexing MONTHS[-1].
  const at = new Date(Date.UTC(year, month, 1))
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
}

function shortDateLabel(value: string): string {
  const [y, m, d] = value.split("-").map(Number)
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`
}

function first(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value ?? undefined
}

/**
 * Resolve a URL query into a SAST window. Unknown keys, malformed dates, a
 * half-supplied custom range and an inverted one all fall back to the default
 * period rather than throwing — this runs on a page render, and a 500 on a
 * hand-edited query string would be a worse failure than a default window.
 *
 * `now` is a required argument rather than an internal `new Date()` so the
 * boundaries are testable without faking the clock.
 */
export function resolvePeriod(input: PeriodInput, now: Date): Period {
  const requested = first(input.period)
  const key = (PERIOD_KEYS as readonly string[]).includes(requested ?? "")
    ? (requested as PeriodKey)
    : DEFAULT_PERIOD_KEY

  if (key === "custom") {
    const from = parseSastDayStart(first(input.from))
    const to = parseSastDayStart(first(input.to))
    const fromYmd = first(input.from)
    const toYmd = first(input.to)
    // Both bounds required, and the range must run forwards.
    if (from && to && fromYmd && toYmd && from.getTime() <= to.getTime()) {
      return {
        key,
        start: from,
        // `to` is an inclusive calendar day, so the exclusive bound is the
        // start of the following day. Without this the whole final day drops.
        end: new Date(to.getTime() + 24 * 60 * 60 * 1000),
        label: `${shortDateLabel(fromYmd)} – ${shortDateLabel(toYmd)}`,
        from: fromYmd,
        to: toYmd,
      }
    }
    return resolvePeriod({ period: DEFAULT_PERIOD_KEY }, now)
  }

  const { year, month, day, weekday } = sastParts(now)

  switch (key) {
    case "today":
      return { key, start: sastDayNumberStart(year, month, day), end: null, label: "Today" }

    case "this-week":
      return {
        key,
        start: sastDayNumberStart(year, month, day - weekday),
        end: null,
        label: "This week",
      }

    case "this-month":
      return {
        key,
        start: sastDayNumberStart(year, month, 1),
        end: null,
        label: monthLabel(year, month),
      }

    case "last-month":
      return {
        key,
        start: sastDayNumberStart(year, month - 1, 1),
        end: sastDayNumberStart(year, month, 1),
        label: monthLabel(year, month - 1),
      }

    case "this-year":
      return { key, start: sastDayNumberStart(year, 0, 1), end: null, label: `${year}` }

    case "all":
      return { key, start: null, end: null, label: "All time" }
  }
}

/**
 * The Prisma filter for a period, or `undefined` for all time.
 *
 * Always `gte`/`lt`. Spread it onto the date field rather than hand-rolling a
 * comparison at each call site, so no caller can reintroduce the `lte`
 * off-by-one-day this module exists to remove:
 *
 *   where: { tenantId, receivedAt: periodFilter(period) }
 */
export function periodFilter(period: Period): { gte?: Date; lt?: Date } | undefined {
  if (!period.start && !period.end) return undefined
  return {
    ...(period.start ? { gte: period.start } : {}),
    ...(period.end ? { lt: period.end } : {}),
  }
}

/**
 * The equivalent window immediately before this one, for a period-over-period
 * delta. Returns `null` where the comparison is meaningless (all time), or
 * where the current window is open-ended and a "preceding equivalent" would be
 * an invention rather than a measurement.
 */
export function precedingPeriod(period: Period, now: Date): Period | null {
  switch (period.key) {
    case "this-month":
      return resolvePeriod({ period: "last-month" }, now)
    case "last-month": {
      const { year, month } = sastParts(period.start!)
      return {
        key: "custom",
        start: sastDayNumberStart(year, month - 1, 1),
        end: sastDayNumberStart(year, month, 1),
        label: monthLabel(year, month - 1),
      }
    }
    default:
      return null
  }
}

/**
 * Serialise a period back to a query string, so the pills, the Export link and
 * any deep link all describe the same window. Round-trips through
 * `resolvePeriod`: whatever this emits, that function resolves to an identical
 * `Period`.
 */
export function periodQuery(period: Period): string {
  const params = new URLSearchParams({ period: period.key })
  if (period.key === "custom" && period.from && period.to) {
    params.set("from", period.from)
    params.set("to", period.to)
  }
  return params.toString()
}
