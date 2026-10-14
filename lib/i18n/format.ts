import { formatDate, formatDateTime, SAST_TIME_ZONE } from "@/lib/utils"
import { DEFAULT_LOCALE, INTL_TAGS, type Locale } from "./locales"

/**
 * Locale-aware dates for borrower-facing text.
 *
 * Money is deliberately NOT localised: every figure keeps `formatZAR`
 * ("R 1,234.56") in every language, so the amount a borrower reads in the
 * portal is character-for-character the amount on their credit agreement and
 * statement PDFs (which stay English, lib/pdf/.claude.md). ICU also disagrees
 * with itself across these locales (af-ZA "R 1 234,56", zu-ZA "R1,234.56",
 * xh-ZA "R 1 234.56"), which would put three spellings of one amount in one
 * product.
 *
 * Dates are where language matters (month names), so they go through Intl.
 * English keeps the existing helpers' exact output. Another language uses its
 * -ZA tag when the runtime has ICU data for it (Node's full ICU has all four),
 * else en-ZA rather than whatever default the runtime would pick.
 */
const resolved = new Map<Locale, string>()

export function intlTagFor(locale: Locale): string {
  const cached = resolved.get(locale)
  if (cached) return cached
  const tag = INTL_TAGS[locale]
  const supported = Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0
  const result = supported ? tag : INTL_TAGS[DEFAULT_LOCALE]
  resolved.set(locale, result)
  return result
}

/** "14 Oct 2026" in English (formatDate); "14 Okt. 2026", "Okt 14, 2026", … otherwise. */
export function formatDay(date: Date | string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return formatDate(date)
  const d = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat(intlTagFor(locale), {
    timeZone: SAST_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d)
}

/** Date with the month written out: "14 October 2026" / "14 Oktober 2026". */
export function formatLongDay(date: Date | string, locale: Locale): string {
  const d = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat(intlTagFor(locale), {
    timeZone: SAST_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d)
}

/** Day and short month, no year: "14 Oct". */
export function formatDayMonth(date: Date | string, locale: Locale): string {
  const d = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat(intlTagFor(locale), {
    timeZone: SAST_TIME_ZONE,
    day: "numeric",
    month: "short",
  }).format(d)
}

/** Date and 24-hour time. English keeps formatDateTime's exact output. */
export function formatDayTime(date: Date | string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return formatDateTime(date)
  const d = typeof date === "string" ? new Date(date) : date
  const time = new Intl.DateTimeFormat(intlTagFor(locale), {
    timeZone: SAST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d)
  return `${formatDay(d, locale)} ${time}`
}
