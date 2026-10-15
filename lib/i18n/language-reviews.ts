import { DEFAULT_LOCALE, LOCALES, isLocale, normaliseEnabledLocales, type Locale } from "./locales"
import { catalogueHash } from "./catalogue-hash"

/**
 * Turning on af, zu or xh puts a machine-drafted catalogue in front of a
 * lender's borrowers. It needs an explicit acknowledgement that a native
 * speaker reviewed that language, stored per language on
 * `TenantConfig.languageReviews` with who acknowledged it and when. A
 * language without one is refused on write and not served on read.
 *
 * The record pins the catalogue it covers (`catalogueHash`). After any edit to
 * that language's text the record is stale: the language is not served, and
 * enabling it again needs a new acknowledgement.
 */
export type ReviewableLocale = Exclude<Locale, typeof DEFAULT_LOCALE>

export type LanguageReview = {
  /** Who did the native-speaker review (free text, as the admin typed it). */
  reviewer: string
  acknowledgedAt: string
  acknowledgedById: string | null
  acknowledgedByEmail: string | null
  /** catalogueHash(locale) of the text that was reviewed; null on a record that predates it. */
  catalogueHash: string | null
}

export type LanguageReviews = Partial<Record<ReviewableLocale, LanguageReview>>

const REVIEWABLE = LOCALES.filter((l): l is ReviewableLocale => l !== DEFAULT_LOCALE)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The stored JSON, keeping only well-formed entries for known languages. */
export function parseLanguageReviews(stored: unknown): LanguageReviews {
  if (!isRecord(stored)) return {}
  const out: LanguageReviews = {}
  for (const locale of REVIEWABLE) {
    const entry = stored[locale]
    if (isRecord(entry) && typeof entry.reviewer === "string" && entry.reviewer.trim() && typeof entry.acknowledgedAt === "string") {
      out[locale] = {
        reviewer: entry.reviewer,
        acknowledgedAt: entry.acknowledgedAt,
        acknowledgedById: typeof entry.acknowledgedById === "string" ? entry.acknowledgedById : null,
        acknowledgedByEmail: typeof entry.acknowledgedByEmail === "string" ? entry.acknowledgedByEmail : null,
        catalogueHash: typeof entry.catalogueHash === "string" ? entry.catalogueHash : null,
      }
    }
  }
  return out
}

/** The review covers the catalogue as it is now (not edited since). */
export function isReviewCurrent(locale: ReviewableLocale, review: LanguageReview | undefined): boolean {
  return review !== undefined && review.catalogueHash === catalogueHash(locale)
}

/** The languages actually served: enabled AND (English or reviewed in its current text). */
export function servableLocales(enabled: readonly string[] | null | undefined, reviews: unknown): Locale[] {
  const reviewed = parseLanguageReviews(reviews)
  return normaliseEnabledLocales(enabled).filter((l) => l === DEFAULT_LOCALE || isReviewCurrent(l, reviewed[l]))
}

export type LanguageUpdate = {
  enabled: Locale[]
  /** New acknowledgements in this request: language → reviewer. */
  acknowledgements: Partial<Record<ReviewableLocale, string>>
}

/**
 * Validates a write of the enabled languages. `acknowledgements` is
 * `{ "<locale>": { reviewer: string, confirmed: true } }`. Every non-English
 * language in the result must be acknowledged now or already have a stored
 * review of its current text; otherwise the whole write is refused.
 */
export function parseLanguageUpdate(
  input: { enabledLanguages: unknown; acknowledgements: unknown },
  stored: LanguageReviews,
): { ok: true; update: LanguageUpdate } | { ok: false; error: string } {
  const list = input.enabledLanguages
  if (!Array.isArray(list) || !list.every(isLocale) || !list.includes(DEFAULT_LOCALE)) {
    return { ok: false, error: "enabledLanguages must be a list of en, af, zu, xh that includes en" }
  }
  const raw = input.acknowledgements ?? {}
  if (!isRecord(raw)) return { ok: false, error: "languageReviewAcknowledgements must be an object keyed by language" }

  const acknowledgements: LanguageUpdate["acknowledgements"] = {}
  for (const [code, value] of Object.entries(raw)) {
    if (!isLocale(code) || code === DEFAULT_LOCALE) return { ok: false, error: `No review acknowledgement applies to "${code}"` }
    if (!isRecord(value) || value.confirmed !== true || typeof value.reviewer !== "string" || !value.reviewer.trim() || value.reviewer.length > 120) {
      return { ok: false, error: `The ${code} acknowledgement needs confirmed: true and the reviewer's name (1-120 characters)` }
    }
    acknowledgements[code] = value.reviewer.trim()
  }

  const enabled = normaliseEnabledLocales(list)
  const pending = enabled.filter((l): l is ReviewableLocale => l !== DEFAULT_LOCALE && !isReviewCurrent(l, stored[l]) && !acknowledgements[l])
  const unreviewed = pending.filter((l) => !stored[l])
  if (unreviewed.length > 0) {
    return { ok: false, error: `Acknowledge a native-speaker review before enabling: ${unreviewed.join(", ")}` }
  }
  if (pending.length > 0) {
    return { ok: false, error: `The text changed since its review; acknowledge a new native-speaker review for: ${pending.join(", ")}` }
  }
  return { ok: true, update: { enabled, acknowledgements } }
}

/** `stored` with this request's acknowledgements recorded against the actor. */
export function withAcknowledgements(
  stored: LanguageReviews,
  acknowledgements: LanguageUpdate["acknowledgements"],
  actor: { id: string | null; email: string | null },
  now: Date,
): LanguageReviews {
  const next: LanguageReviews = { ...stored }
  for (const [code, reviewer] of Object.entries(acknowledgements) as [ReviewableLocale, string][]) {
    next[code] = {
      reviewer,
      acknowledgedAt: now.toISOString(),
      acknowledgedById: actor.id,
      acknowledgedByEmail: actor.email,
      catalogueHash: catalogueHash(code),
    }
  }
  return next
}
