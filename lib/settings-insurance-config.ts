// Browser-side access to the Phase 1 rate-table and eligibility-rule routes.
//
// Same shape as `lib/settings-insurers.ts`: types the JSON actually has, and
// loaders that throw on a non-OK response rather than letting a screen render
// an error body as a rate card.
//
// TWO THINGS THE TYPES HERE ARE LOAD-BEARING ABOUT.
//
// `Decimal` columns do NOT arrive as numbers. Prisma serialises
// `Decimal(12, 2)` through `toJSON`, so `sumAssured` and `premiumAmount` reach
// the browser as STRINGS — "10000" and "45.5". Typing them `number` would
// compile and then compare "10000" against 10000 for the rest of the screen.
// They are typed as they arrive and converted once, at the boundary, by
// `toRands`.
//
// Money is in RANDS, not cents, throughout the IMS — the schema comment on
// `InsuranceRateBand.premiumAmount` says so, and `parseDecimalAmount` on the
// write side accepts rands. Nothing here multiplies by 100 except `formatZAR`,
// which takes cents, at the moment of display.

import type {
  EligibilityLifeScope,
  EligibilityRuleType,
  InsuredLifeType,
  RateBasis,
  RateTableStatus,
} from "@prisma/client"

/** A `Decimal` column as it arrives over JSON. */
export type JsonDecimal = string | number

export interface RateTableSummary {
  id: string
  productId: string
  insurerId: string | null
  version: number
  name: string
  status: RateTableStatus
  basis: RateBasis
  effectiveFrom: string
  effectiveTo: string | null
  createdAt: string
  _count: { bands: number }
}

export interface RateBandRow {
  id: string
  rateTableId: string
  lifeType: InsuredLifeType
  minAge: number
  maxAge: number
  sumAssured: JsonDecimal
  premiumAmount: JsonDecimal
}

export interface RateTableDetail extends Omit<RateTableSummary, "_count"> {
  bands: RateBandRow[]
}

export interface EligibilityRuleRow {
  id: string
  productId: string
  lifeScope: EligibilityLifeScope
  ruleType: EligibilityRuleType
  numericValue: JsonDecimal | null
  textValue: string | null
  active: boolean
}

/** A `Decimal` column as rands. */
export function toRands(value: JsonDecimal): number {
  return typeof value === "number" ? value : Number(value)
}

/**
 * The server's own words for a refusal.
 *
 * These routes answer with informative 409s — which draft lost a race, which
 * two bands would price the same life, which mandatory term is missing — and
 * replacing them with "something went wrong" throws away the only thing that
 * tells an operator what to do next. A body that will not parse falls back to
 * the status code, which is still more than nothing.
 */
export async function readApiError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown }
    if (typeof data.error === "string" && data.error.trim() !== "") return data.error
  } catch {
    // fall through
  }
  return `The server refused the request (HTTP ${res.status}).`
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(await readApiError(res))
  return (await res.json()) as T
}

export function loadRateTables(productId: string): Promise<RateTableSummary[]> {
  return getJson<RateTableSummary[]>(
    `/api/insurance/rate-tables?productId=${encodeURIComponent(productId)}`
  )
}

export function loadRateTable(id: string): Promise<RateTableDetail> {
  return getJson<RateTableDetail>(`/api/insurance/rate-tables/${encodeURIComponent(id)}`)
}

export function loadEligibilityRules(productId: string): Promise<EligibilityRuleRow[]> {
  return getJson<EligibilityRuleRow[]>(
    `/api/insurance/eligibility-rules?productId=${encodeURIComponent(productId)}`
  )
}

/**
 * A number for a field the API parses as one, or `null` for anything that is
 * not one.
 *
 * Blank and unparseable both become null DELIBERATELY, rather than being caught
 * by a second validator in the browser. `parseDecimalAmount` and `parseBandInput`
 * are where the rules for these columns live — a client-side copy of "greater
 * than zero once stored at 2 decimal places" would be a second implementation
 * of a money rule, and this repo has the drift scars to show for those. Null
 * reaches the route and comes back as the route's own message.
 *
 * `Number("")` is 0, which is why blank is intercepted here: a blank premium is
 * not a premium of zero, and it should not be reported as one.
 */
export function numberOrNull(value: string): number | null {
  if (value.trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
