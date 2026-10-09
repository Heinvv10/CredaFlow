// app/api/insurance/eligibility-rules/rule-input.ts
//
// Shared input parsing for the free-text half of an eligibility rule, used by
// both the collection route (POST) and the item route (PATCH) so the two
// cannot drift on what a captured insurer term may contain.

// `InsuranceEligibilityRule.textValue` is an unbounded `String?` — Postgres
// TEXT — so nothing below this module limits what a caller can store. These
// rows are a term captured off an insurer's schedule, not a notes field.
export const MAX_TEXT_VALUE = 1000

export type TextValueResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string }

export function parseTextValue(value: unknown): TextValueResult {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== "string") {
    return { ok: false, error: "textValue must be a string or null" }
  }

  const trimmed = value.trim()
  if (trimmed.length > MAX_TEXT_VALUE) {
    return { ok: false, error: `textValue must be at most ${MAX_TEXT_VALUE} characters` }
  }
  // An all-whitespace term is not a term.
  return { ok: true, value: trimmed === "" ? null : trimmed }
}
