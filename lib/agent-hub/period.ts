// SAST is a fixed UTC+2 offset with no daylight saving, so the conversion is a
// constant. Using a fixed offset keeps this pure and testable; a tz library
// would drag I/O and a much larger surface into a function that needs neither.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function sastMidnightUtc(isoDate: string): Date {
  if (!DATE_RE.test(isoDate)) throw new Error(`Date must be YYYY-MM-DD, got "${isoDate}"`)
  const asUtcMidnight = new Date(`${isoDate}T00:00:00.000Z`)
  if (Number.isNaN(asUtcMidnight.getTime())) throw new Error(`Date must be YYYY-MM-DD, got "${isoDate}"`)

  // Reject calendar-invalid dates that silently roll over (e.g., 2026-02-30 → 2026-03-02).
  // Parse the input to extract expected year, month, day.
  const [yearStr, monthStr, dayStr] = isoDate.split("-")
  const expectedYear = Number(yearStr)
  const expectedMonth = Number(monthStr)
  const expectedDay = Number(dayStr)

  // Check parsed UTC date against input. If they differ, the date rolled over.
  if (
    asUtcMidnight.getUTCFullYear() !== expectedYear ||
    asUtcMidnight.getUTCMonth() + 1 !== expectedMonth ||
    asUtcMidnight.getUTCDate() !== expectedDay
  ) {
    throw new Error(`Date must be YYYY-MM-DD, got "${isoDate}"`)
  }

  return new Date(asUtcMidnight.getTime() - SAST_OFFSET_MS)
}

function todayInSast(): { year: number; month: number; day: number } {
  const nowSast = new Date(Date.now() + SAST_OFFSET_MS)
  return { year: nowSast.getUTCFullYear(), month: nowSast.getUTCMonth() + 1, day: nowSast.getUTCDate() }
}

const pad = (n: number) => String(n).padStart(2, "0")

export function parsePeriod(from?: string | null, to?: string | null): { fromUtc: Date; toUtc: Date; label: string } {
  // Next.js genuinely hands back "" (not undefined) for a present-but-empty
  // query param — e.g. `?from=` from a date-filter form field the user
  // cleared before submitting. The `|| default` fallback below treats "" the
  // same as a truly absent (undefined/null) param, which would silently
  // report a different period than the URL asked for. Reject it explicitly
  // instead of aliasing it to "absent": a caller that wants the default must
  // omit the key, not send it empty.
  if (from === "") throw new Error(`Period start must not be an empty string; omit "from" to use the default`)
  if (to === "") throw new Error(`Period end must not be an empty string; omit "to" to use the default`)

  const today = todayInSast()
  const fromDate = from || `${today.year}-${pad(today.month)}-01`
  const toDate = to || `${today.year}-${pad(today.month)}-${pad(today.day)}`

  const fromUtc = sastMidnightUtc(fromDate)
  // Exclusive upper bound: midnight at the START of the day after `toDate`, so
  // events during the to-date itself are included.
  const toUtc = new Date(sastMidnightUtc(toDate).getTime() + 24 * 60 * 60 * 1000)

  if (fromUtc >= toUtc) throw new Error(`Period start ${fromDate} must be before end ${toDate}`)
  return { fromUtc, toUtc, label: `${fromDate} to ${toDate}` }
}
