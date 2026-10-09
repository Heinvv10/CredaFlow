/**
 * Formats a cents value (stored as a string in wizard state) as a rand amount
 * with thousand-separators and 2 decimals (en-ZA locale).
 *
 *   displayCents("")        → "—"
 *   displayCents("abc")     → "—"
 *   displayCents("525000")  → "R 5,250.00"
 *
 * Returns the em-dash placeholder for blank or non-numeric input so the UI
 * shows a neutral marker instead of "RNaN".
 */
export function displayCents(cents: string): string {
  if (!cents) return "—"
  const n = Number(cents)
  if (Number.isNaN(n)) return "—"
  // Non-breaking space (U+00A0) keeps "R" glued to the amount so it never wraps
  // onto its own line in the narrow affordability cards. UI-only formatter.
  return `R\u00A0${(n / 100).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
