/**
 * The one normaliser for asset serial numbers and VINs. A serial typed as
 * "TEST F8", "test-f8", "TEST.F8" or with a non-breaking or zero-width space
 * is one machine: the app stores the normalised value, and the database's
 * book-wide duplicate checks (indexes and the cross-column trigger,
 * migration 20261013114100_asset_finance_review_assets) compare
 * assetIdentifierKey, the SQL twin of normaliseAssetIdentifier.
 *
 * Normalised: every whitespace character (JavaScript \s: ASCII spaces, tab,
 * newline, NBSP and the other Unicode spaces), every zero-width character and
 * the separators - / . _ removed; upper case. What is left may not contain a
 * control or format character (CHECK FinancedAsset_identifiers_printable).
 */

// \s, plus NEL, Mongolian vowel separator, zero-width space/non-joiner/joiner and word joiner.
const STRIPPED = /[\s\u0085᠎​-‍⁠﻿/._-]/gu
// Control (Cc) and format (Cf: bidi marks, soft hyphen, ...) characters.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u

export function normaliseAssetIdentifier(value: string): string {
  return value.replace(STRIPPED, "").toUpperCase()
}

/** The normalised identifier, or an error when nothing printable is left or a control character remains. */
export function parseAssetIdentifier(value: string): { value: string } | { error: string } {
  const normalised = normaliseAssetIdentifier(value)
  if (normalised.length === 0) return { error: "is required" }
  if (UNPRINTABLE.test(normalised)) return { error: "may not contain control or invisible characters" }
  return { value: normalised }
}

/** The typed identifier is the asset's serial or VIN, as the duplicate checks compare them. */
export function identifierMatchesAsset(typed: string, asset: { serialNumber: string; vin: string | null }): boolean {
  const key = normaliseAssetIdentifier(typed)
  if (key === "") return false
  return key === normaliseAssetIdentifier(asset.serialNumber) || (asset.vin !== null && key === normaliseAssetIdentifier(asset.vin))
}
