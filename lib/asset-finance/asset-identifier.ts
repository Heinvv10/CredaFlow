/**
 * The one policy for asset serial numbers and VINs, mirrored in SQL by
 * assetIdentifierKey and the CHECK FinancedAsset_identifiers_valid
 * (migration 20261013114500_asset_finance_review_round3).
 *
 * ALLOWED. After NFKC normalisation (which folds fullwidth letters and
 * digits, NBSP and the other Unicode spaces to their ASCII forms) an
 * identifier holds only ASCII letters and digits and the separators
 * space - / . _ . Anything else is refused, never silently dropped: dashes
 * other than the hyphen-minus (en/em dash, minus sign), other punctuation
 * (comma, colon, backslash, #, parentheses), letters outside A-Z (Cyrillic or
 * Greek look-alikes, accents), and control, format or zero-width characters
 * (tab, newline, soft hyphen, zero-width space, BOM).
 *
 * KEY. "TEST F8", "test-f8", "TEST.F8" and "ＴＥＳＴ F8" are one machine: the
 * key is the NFKC form with the separators removed, ASCII upper case. The app
 * stores the key; the database's book-wide duplicate checks (expression
 * indexes and the cross-column trigger) compare assetIdentifierKey.
 */

const ALLOWED = /^[A-Za-z0-9 ./_-]+$/
const SEPARATORS = /[ ./_-]/g

/** The duplicate-check key: NFKC, separators removed, ASCII letters upper-cased (SQL: assetIdentifierKey). */
export function normaliseAssetIdentifier(value: string): string {
  return value.normalize("NFKC").replace(SEPARATORS, "").replace(/[a-z]/g, (c) => c.toUpperCase())
}

/** The key to store, or why the value is not an identifier. */
export function parseAssetIdentifier(value: string): { value: string } | { error: string } {
  const normalised = value.normalize("NFKC")
  if (normalised !== "" && !ALLOWED.test(normalised)) {
    return {
      error: "may contain only the letters A-Z, digits 0-9, spaces and the separators - / . _ "
        + "(no other dashes or punctuation, no accented or non-Latin letters, no tabs or invisible characters)",
    }
  }
  const key = normaliseAssetIdentifier(value)
  return key === "" ? { error: "is required" } : { value: key }
}

/** The typed identifier is the asset's serial or VIN, as the duplicate checks compare them; never for a refused value. */
export function identifierMatchesAsset(typed: string, asset: { serialNumber: string; vin: string | null }): boolean {
  const parsed = parseAssetIdentifier(typed)
  if ("error" in parsed) return false
  return parsed.value === normaliseAssetIdentifier(asset.serialNumber) || (asset.vin !== null && parsed.value === normaliseAssetIdentifier(asset.vin))
}
