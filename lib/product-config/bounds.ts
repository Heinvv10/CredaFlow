// Structural sanity for a loan product's amount and term bounds, checked on
// the RAW request values (amounts in rand, terms in days) before any coercion.
// Downstream code (CRM convert, portal apply) trusts these values.
// No policy upper cap: the int4 ceiling is the Postgres Int column's storage
// limit, not a product limit. Any policy cap is the owner's decision.

export const INT4_MAX = 2_147_483_647

function cents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null
  const c = Math.round(v * 100)
  return Number.isInteger(c) && c > 0 && c <= INT4_MAX ? c : null
}

function days(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= INT4_MAX ? v : null
}

export function loanProductBoundsIssues(raw: {
  minAmount: unknown
  maxAmount: unknown
  minTermDays: unknown
  maxTermDays: unknown
}): string[] {
  const issues: string[] = []
  const minAmount = cents(raw.minAmount)
  const maxAmount = cents(raw.maxAmount)
  if (minAmount === null) issues.push("minAmount")
  if (maxAmount === null || (minAmount !== null && maxAmount < minAmount)) issues.push("maxAmount")
  const minTerm = days(raw.minTermDays)
  const maxTerm = days(raw.maxTermDays)
  if (minTerm === null) issues.push("minTermDays")
  if (maxTerm === null || (minTerm !== null && maxTerm < minTerm)) issues.push("maxTermDays")
  return issues
}
