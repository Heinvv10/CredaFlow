/**
 * The languages the borrower-facing surfaces speak: the public website, the
 * client portal and borrower comms. The staff app, the NCA documents
 * (lib/pdf) and legal text stay English whatever is chosen here.
 *
 * The codes are the ones `MessageTemplate.language` already carries for
 * WhatsApp templates ("en" default), so a borrower's preference can select a
 * template row without translation between two code systems.
 */
export const LOCALES = ["en", "af", "zu", "xh"] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "en"

/** Each language named in itself: a reader who cannot read English must still find their own. */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  af: "Afrikaans",
  zu: "isiZulu",
  xh: "isiXhosa",
}

/** BCP 47 tags for Intl formatting, South African region throughout. */
export const INTL_TAGS: Record<Locale, string> = {
  en: "en-ZA",
  af: "af-ZA",
  zu: "zu-ZA",
  xh: "xh-ZA",
}

/** The cookie the language switcher writes. Read server-side only. */
export const LOCALE_COOKIE = "cf-locale"

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value)
}

/**
 * A tenant's stored `enabledLanguages`, made safe to use: unknown codes
 * dropped, duplicates removed, LOCALES order, and English always present —
 * English is the language of the NCA documents and the fallback for every
 * missing preference, so no tenant can switch it off.
 */
export function normaliseEnabledLocales(stored: readonly string[] | null | undefined): Locale[] {
  const wanted = new Set<string>(stored ?? [])
  wanted.add(DEFAULT_LOCALE)
  return LOCALES.filter((locale) => wanted.has(locale))
}

/**
 * Accept-Language → locale codes in the browser's order of preference.
 * Region subtags are ignored ("af-ZA" → "af"); q=0 means "not this one".
 */
export function parseAcceptLanguage(header: string | null | undefined): Locale[] {
  if (!header) return []
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [range, ...params] = part.trim().split(";")
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="))
      const weight = q ? Number(q.slice(2)) : 1
      return { code: range.trim().toLowerCase().split("-")[0], weight: Number.isFinite(weight) ? weight : 0, index }
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
  const out: Locale[] = []
  for (const { code } of ranked) {
    if (isLocale(code) && !out.includes(code)) out.push(code)
  }
  return out
}

/**
 * The language to render, from the signals in order of authority:
 * the switcher cookie (an explicit choice on this browser), the signed-in
 * client's stored preference, then the browser's Accept-Language. A signal
 * naming a language the tenant has not enabled is skipped, not honoured.
 */
export function negotiateLocale(input: {
  enabled: readonly Locale[]
  cookie?: string | null
  profile?: string | null
  acceptLanguage?: string | null
}): Locale {
  const allowed = (value: unknown): value is Locale => isLocale(value) && input.enabled.includes(value)
  if (allowed(input.cookie)) return input.cookie
  if (allowed(input.profile)) return input.profile
  const fromBrowser = parseAcceptLanguage(input.acceptLanguage).find(allowed)
  return fromBrowser ?? DEFAULT_LOCALE
}
