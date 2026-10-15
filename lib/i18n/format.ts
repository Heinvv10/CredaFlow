import { formatDate, formatDateTime, SAST_TIME_ZONE } from "@/lib/utils"
import { sastParts } from "@/lib/date/sast"
import { DEFAULT_LOCALE, type Locale } from "./locales"

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
 * Dates are where language matters (month names). English keeps the existing
 * Intl helpers' exact output. Afrikaans, isiZulu and isiXhosa do NOT call Intl:
 * Node's full ICU has all three, but Chrome ships no zu or xh data
 * (supportedLocalesOf → [], checked on Chrome 146) and silently formats in
 * English instead, so a client component would render a different string from
 * the server and fail hydration. They are written from the CLDR month names
 * and patterns below (ICU 78 / CLDR 48, the data Node itself uses), which
 * come out identical on every runtime. Calendar day is the SAST day.
 */
type DateWords = {
  short: readonly string[]
  long: readonly string[]
  /** CLDR order: "d MMM y" (af) or "MMM d, y" (zu, xh). */
  dayFirst: boolean
}

const WORDS: Record<Exclude<Locale, "en">, DateWords> = {
  af: {
    short: ["Jan.", "Feb.", "Mrt.", "Apr.", "Mei", "Jun.", "Jul.", "Aug.", "Sep.", "Okt.", "Nov.", "Des."],
    long: ["Januarie", "Februarie", "Maart", "April", "Mei", "Junie", "Julie", "Augustus", "September", "Oktober", "November", "Desember"],
    dayFirst: true,
  },
  zu: {
    short: ["Jan", "Feb", "Mas", "Eph", "Mey", "Jun", "Jul", "Aga", "Sep", "Okt", "Nov", "Dis"],
    long: ["Januwari", "Februwari", "Mashi", "Ephreli", "Meyi", "Juni", "Julayi", "Agasti", "Septhemba", "Okthoba", "Novemba", "Disemba"],
    dayFirst: false,
  },
  xh: {
    short: ["Jan", "Feb", "Mat", "Epr", "Mey", "Jun", "Jul", "Aga", "Sept", "Okt", "Nov", "Dis"],
    long: ["Janyuwari", "Februwari", "Matshi", "Epreli", "Meyi", "Juni", "Julayi", "Agasti", "Septemba", "Okthobha", "Novemba", "Disemba"],
    dayFirst: false,
  },
}

const toDate = (date: Date | string) => (typeof date === "string" ? new Date(date) : date)

function dayMonth(words: DateWords, day: number, month: string): string {
  return words.dayFirst ? `${day} ${month}` : `${month} ${day}`
}

function withYear(words: DateWords, day: number, month: string, year: number): string {
  return words.dayFirst ? `${day} ${month} ${year}` : `${month} ${day}, ${year}`
}

/** "14 Oct 2026" in English (formatDate); "14 Okt. 2026", "Okt 14, 2026" otherwise. */
export function formatDay(date: Date | string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return formatDate(date)
  const words = WORDS[locale]
  const { year, month, day } = sastParts(toDate(date))
  return withYear(words, day, words.short[month], year)
}

/** Date with the month written out: "14 October 2026" / "14 Oktober 2026" / "Okthoba 14, 2026". */
export function formatLongDay(date: Date | string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) {
    return new Intl.DateTimeFormat("en-ZA", { timeZone: SAST_TIME_ZONE, day: "numeric", month: "long", year: "numeric" }).format(toDate(date))
  }
  const words = WORDS[locale]
  const { year, month, day } = sastParts(toDate(date))
  return withYear(words, day, words.long[month], year)
}

/** Day and short month, no year: "14 Oct" / "14 Okt." / "Okt 14". */
export function formatDayMonth(date: Date | string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) {
    return new Intl.DateTimeFormat("en-ZA", { timeZone: SAST_TIME_ZONE, day: "numeric", month: "short" }).format(toDate(date))
  }
  const words = WORDS[locale]
  const { month, day } = sastParts(toDate(date))
  return dayMonth(words, day, words.short[month])
}

/** Date and 24-hour SAST time. English keeps formatDateTime's exact output. */
export function formatDayTime(date: Date | string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return formatDateTime(date)
  const d = toDate(date)
  // Digits only, so any runtime's ICU gives the same "08:05".
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: SAST_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(d)
  return `${formatDay(d, locale)} ${time}`
}
