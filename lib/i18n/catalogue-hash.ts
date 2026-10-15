import { createHash } from "node:crypto"
import { CATALOGS } from "./catalog"
import type { Locale } from "./locales"

/** Key-sorted JSON, so moving a key is not a change and editing any text is. */
function stableJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value)
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`
}

const cache = new Map<Locale, string>()

/**
 * sha256 of a language's whole catalogue (every namespace, every string). A
 * native-speaker review record stores the hash it reviewed; once the
 * catalogue changes the record no longer matches and the language is not
 * served until someone acknowledges a review of the new text.
 */
export function catalogueHash(locale: Locale): string {
  let hash = cache.get(locale)
  if (!hash) {
    hash = createHash("sha256").update(stableJson(CATALOGS[locale])).digest("hex")
    cache.set(locale, hash)
  }
  return hash
}
