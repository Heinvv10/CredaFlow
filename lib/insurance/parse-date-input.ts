/**
 * Parses a caller-supplied date on the insurance quote/bind seams.
 *
 * A rate card's `effectiveFrom` is stamped at the instant it is activated
 * (07:39 this morning, say). A caller who writes `"2026-08-17"` means today —
 * but `new Date("2026-08-17")` is midnight UTC, which is *before* the card came
 * into force and two hours before the SAST day even began. So a card activated
 * this morning could not be quoted against today: `RATE_TABLE_UNRESOLVED`. The
 * same string at the bind seam resolved to an instant in the past and tripped
 * "cover cannot be backdated".
 *
 * The fix belongs here, at the input, not at activation. Stamping
 * `effectiveFrom` at midnight instead would break the invariant that exactly
 * one rate table is ACTIVE at any instant — the predecessor's `effectiveTo`
 * equals its successor's `effectiveFrom`, so back-stamping leaves quotes made
 * earlier the same day resolving to neither card.
 *
 * A date-only string naming TODAY therefore resolves to `now`. Any other
 * date-only string resolves to SAST midnight of that day, so a back-dated input
 * stays in the past and the downstream guards that reject back-dating still
 * fire. A full timestamp is honoured verbatim.
 */

// SAST is a fixed UTC+2 offset with no daylight saving, so the conversion is a
// constant — matching `lib/agent-hub/period.ts`, which does the same arithmetic
// for the same reason.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
/** Date-shaped but not strictly ISO — `"2026-8-17"`. Refused, never guessed at. */
const LOOSE_DATE_RE = /^\d{1,4}-\d{1,2}-\d{1,2}$/

/** The calendar date in SAST at a given instant, as `YYYY-MM-DD`. */
function sastCalendarDate(at: Date): string {
  const shifted = new Date(at.getTime() + SAST_OFFSET_MS)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * Midnight SAST on `isoDate`, or null if the string is not a real calendar
 * date. `new Date("2026-02-30")` is NOT NaN — it rolls silently to 2 March, so
 * the round-trip check below is what rejects it. Pricing a quote against a day
 * the caller never named is worse than refusing the request.
 */
function sastMidnightUtc(isoDate: string): Date | null {
  const asUtcMidnight = new Date(`${isoDate}T00:00:00.000Z`)
  if (Number.isNaN(asUtcMidnight.getTime())) return null

  const [year, month, day] = isoDate.split("-").map(Number)
  if (
    asUtcMidnight.getUTCFullYear() !== year ||
    asUtcMidnight.getUTCMonth() + 1 !== month ||
    asUtcMidnight.getUTCDate() !== day
  ) {
    return null
  }

  return new Date(asUtcMidnight.getTime() - SAST_OFFSET_MS)
}

/**
 * @param raw   the caller's string, already coerced with `String(...)`
 * @param now   injected so the "is this today" question is testable
 * @returns the instant, or null if `raw` is not a usable date (caller returns 422)
 */
export function parseInsuranceDateInput(raw: string, now: Date = new Date()): Date | null {
  // Trim BEFORE the shape test. `" 2026-08-17"` fails a strict anchored regex
  // and would fall through to `new Date(raw)` — which parses it happily, to
  // midnight. That is the exact bug this helper exists to remove, sneaking back
  // in behind a leading space.
  const trimmed = raw.trim()

  if (DATE_ONLY_RE.test(trimmed)) {
    if (trimmed === sastCalendarDate(now)) return now
    return sastMidnightUtc(trimmed)
  }

  // A date-shaped string that is not strictly `YYYY-MM-DD` (`"2026-8-17"`) is
  // REFUSED rather than parsed. `new Date` would read it in the runtime's own
  // timezone — UTC in the container, SAST on a developer's machine — so the
  // same request would price against different days depending on where it ran.
  // A caller who means a date can pad it; guessing on their behalf is how a
  // quote gets priced against a day nobody named.
  if (LOOSE_DATE_RE.test(trimmed)) return null

  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The same parsing for an END boundary — a quote's `expiresAt`.
 *
 * A bare date names the LAST day a quote is valid, so it resolves to the end of
 * that SAST day: midnight at the START of the following day, matching the
 * end-exclusive convention `expiresAt <= now` is written against.
 *
 * This is NOT `parseInsuranceDateInput`, and must not be replaced by it. That
 * helper resolves a bare date to the FIRST instant of the day (or to `now` when
 * the day is today) — correct for a start boundary, and for an expiry it would
 * kill the quote before the day it names has even begun. A caller who writes
 * today's date as an expiry means "valid for the rest of today", the exact
 * opposite of the "today means now" rule above.
 *
 * Takes no `now`: unlike its sibling, nothing here depends on the current
 * instant. A named day resolves to the same boundary whenever it is asked.
 */
export function parseInsuranceExpiryInput(raw: string): Date | null {
  const trimmed = raw.trim()

  if (DATE_ONLY_RE.test(trimmed)) {
    const dayStart = sastMidnightUtc(trimmed)
    return dayStart === null ? null : new Date(dayStart.getTime() + DAY_MS)
  }

  if (LOOSE_DATE_RE.test(trimmed)) return null

  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
