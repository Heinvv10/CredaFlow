/**
 * Calendar-quarter primitives shared by every statutory quarterly return
 * (NCR s.52 / FSCA conduct-of-business) and by the Section 129 register.
 *
 * ONE implementation, deliberately. Before this module there were three:
 * `lib/fsca-return.ts` computed UTC-midnight bounds, `lib/collections/
 * section129-reporting.ts` computed SAST-midnight bounds, and
 * `app/(dashboard)/compliance/ncr-return/page.tsx` used `new Date(y, m, 1)`,
 * which is whatever the container's local timezone happens to be. Three
 * definitions of "Q3" is three different answers to "was this loan in the
 * quarter", on returns filed with two different regulators.
 *
 * The SAST primitives themselves now live in `lib/date/sast.ts`, shared with
 * the reporting period filters, so the offset arithmetic has one home rather
 * than one per consumer.
 *
 * Quarter strings are "YYYY-Qn", n ∈ [1..4]. Bounds are end-EXCLUSIVE and are
 * SAST-midnight instants expressed in UTC, suitable for direct use in Prisma
 * `gte` / `lt` filters. South Africa is fixed at UTC+02:00 with no
 * daylight-saving transitions, so the offset is a constant and the result does
 * not depend on the host's local timezone.
 *
 * Why SAST and not UTC: a loan disbursed at 00:30 on 1 October in Johannesburg
 * is 22:30 on 30 September in UTC. Under UTC bounds it lands in Q3; the
 * business, its books and the regulator all say Q4. The window is two hours
 * wide at every quarter edge and it silently moves loans between returns.
 */

import { sastMonthStart, sastParts } from "@/lib/date/sast"

export const QUARTER_RE = /^(\d{4})-Q([1-4])$/

/** How many quarters the selector offers, including the current one. */
export const SELECTABLE_QUARTER_COUNT = 5

export type QuarterBounds = { start: Date; end: Date }

export function quarterBounds(quarter: string): QuarterBounds {
  const match = quarter.match(QUARTER_RE)
  if (!match) throw new Error(`Invalid quarter string: ${quarter}`)
  const year = Number(match[1])
  const startMonth = (Number(match[2]) - 1) * 3
  return {
    start: sastMonthStart(year, startMonth),
    end: sastMonthStart(year, startMonth + 3),
  }
}

export function currentQuarter(now: Date = new Date()): string {
  const { year, month } = sastParts(now)
  return `${year}-Q${Math.floor(month / 3) + 1}`
}

export function shiftQuarter(quarter: string, deltaQuarters: number): string {
  const match = quarter.match(QUARTER_RE)
  if (!match) throw new Error(`Invalid quarter string: ${quarter}`)
  const year = Number(match[1])
  const q = Number(match[2])
  const totalQ = year * 4 + (q - 1) + deltaQuarters
  return `${Math.floor(totalQ / 4)}-Q${(totalQ % 4) + 1}`
}

/** Current quarter first, then the four preceding it, newest to oldest. */
export function listSelectableQuarters(now: Date = new Date()): string[] {
  const current = currentQuarter(now)
  return Array.from({ length: SELECTABLE_QUARTER_COUNT }, (_, i) =>
    shiftQuarter(current, -i),
  )
}

/**
 * The quarter a return is normally filed for: the one that has just closed.
 * The current quarter is still selectable (staff preview it mid-quarter) but
 * is never the default, because a return filed for an open quarter is
 * incomplete by construction.
 */
export function defaultQuarter(now: Date = new Date()): string {
  return shiftQuarter(currentQuarter(now), -1)
}

/**
 * Coerce an untrusted `?quarter=` param to a quarter the caller may actually
 * report on. Anything malformed or outside the selectable window collapses to
 * the default rather than erroring — a bad URL should show the normal report,
 * not a 500 on a compliance surface.
 */
export function parseQuarterParam(
  raw: string | undefined,
  now: Date = new Date(),
): string {
  if (!raw || !QUARTER_RE.test(raw)) return defaultQuarter(now)
  return listSelectableQuarters(now).includes(raw) ? raw : defaultQuarter(now)
}

/** True when `quarter` has not closed yet, so its figures are still moving. */
export function isQuarterOpen(quarter: string, now: Date = new Date()): boolean {
  return quarterBounds(quarter).end.getTime() > now.getTime()
}

/** Bounds of the quarter containing `now`. */
export function sastQuarterBounds(now: Date): { start: Date; endExclusive: Date } {
  const { start, end } = quarterBounds(currentQuarter(now))
  return { start, endExclusive: end }
}

/**
 * SAST-midnight bounds of a calendar month, end-EXCLUSIVE. `monthOffset` walks
 * backwards or forwards from the month containing `instant`.
 *
 * End-exclusive matters. The reports were written as
 * `new Date(y, m + 1, 0)` — the last DAY of the month at 00:00 — and then
 * filtered `lte` that instant, which silently dropped every receipt after
 * midnight on the last day of the month from the collection rate, the
 * month-over-month disbursement comparison and every bar of the trend chart.
 */
export function sastMonthBounds(
  instant: Date,
  monthOffset = 0,
): { start: Date; end: Date } {
  const { year, month } = sastParts(instant)
  return {
    start: sastMonthStart(year, month + monthOffset),
    end: sastMonthStart(year, month + monthOffset + 1),
  }
}

/** "2026-Q3" → "Q3 2026", for headings and filenames. */
export function quarterLabel(quarter: string): string {
  const match = quarter.match(QUARTER_RE)
  if (!match) throw new Error(`Invalid quarter string: ${quarter}`)
  return `Q${match[2]} ${match[1]}`
}
