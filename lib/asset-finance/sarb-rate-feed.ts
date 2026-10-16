/**
 * The South African Reserve Bank's public rates feed (DESIGN.md D4): the
 * policy (repo) rate, the prime lending rate and ZARONIA, as
 * lib/asset-finance/rate-feed-sync.ts records them.
 *
 * GET HomePageRates answers a JSON array of
 * `{ Name, SectionId, TimeseriesCode, Date: "YYYY-MM-DD", Value: <percent>, ... }`
 * rows, one per series, mixed with series this module ignores (CPI, exchange
 * rates). `Date` is the date of the observation, not of a change: it moves
 * every business day while the value stands still.
 *
 * Nothing here retries or defaults: a feed that is down, slow, reshaped, or
 * carries an implausible value is a typed error the caller surfaces, never a
 * guess. Percent becomes the decimal fraction the ReferenceRate table holds
 * (7.097 -> 0.07097) in decimal arithmetic, so no float error reaches the
 * database. The fetch is injectable; tests never reach the real endpoint.
 */
import { Prisma, type ReferenceRateBasis } from "@prisma/client"
import { toDayNumber } from "./dates"

export const SARB_FEED_URL = "https://custom.resbank.co.za/SarbWebApi/WebIndicators/HomePageRates"
export const SARB_FEED_TIMEOUT_MS = 15_000

export type FeedBasis = Extract<ReferenceRateBasis, "REPO" | "PRIME" | "ZARONIA">

/** The feed's series code for each basis it supplies. JIBAR and the lender's base rate have no free source. */
export const SARB_SERIES: Readonly<Record<string, FeedBasis>> = {
  MMRD002A: "REPO", // "SARB Policy Rate"
  MMRD000A: "PRIME",
  MMRD855A: "ZARONIA",
}

// Mirrors the table: DECIMAL(9,6) holds a percent to 4 places, and the CHECK
// ReferenceRate_rate_band allows 0 < rate < 0.5 (a percent from 0 to 50, both excluded).
const MAX_PERCENT_PLACES = 4
const PERCENT_BAND = { exclusiveMin: 0, exclusiveMax: 50 } as const
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface SarbObservation {
  basis: FeedBasis
  timeseriesCode: string
  /** The feed's observation date, ISO "YYYY-MM-DD". */
  effectiveDate: string
  /** Annual nominal decimal: 0.1075 = 10.75%. */
  rate: Prisma.Decimal
}

export type SarbFeedErrorReason =
  | "timeout"
  | "network"
  | "http_status"
  | "not_json"
  | "bad_shape"
  | "missing_series"
  | "duplicate_series"
  | "bad_date"
  | "bad_value"

export interface SarbFeedError {
  ok: false
  reason: SarbFeedErrorReason
  detail: string
}

export type SarbFeedResult = { ok: true; observations: SarbObservation[] } | SarbFeedError

const failure = (reason: SarbFeedErrorReason, detail: string): SarbFeedError => ({ ok: false, reason, detail })

/** Percent as the feed prints it (a JSON number) to the decimal fraction, exactly; null if unusable. */
export function percentToDecimalFraction(percent: unknown): Prisma.Decimal | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null
  if (!(percent > PERCENT_BAND.exclusiveMin && percent < PERCENT_BAND.exclusiveMax)) return null
  // String(7.097) is "7.097": the shortest text that reads back as the same number.
  const exact = new Prisma.Decimal(String(percent))
  if (exact.decimalPlaces() > MAX_PERCENT_PLACES) return null
  return exact.div(100)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false
  try {
    toDayNumber(value)
    return true
  } catch {
    return false
  }
}

/** Validates the decoded feed body and picks out the series this module uses. */
export function parseSarbFeed(body: unknown): SarbFeedResult {
  if (!Array.isArray(body)) return failure("bad_shape", "the feed body is not an array")
  const observations: SarbObservation[] = []
  for (const [timeseriesCode, basis] of Object.entries(SARB_SERIES)) {
    const matches = body.filter((row) => isObject(row) && row.TimeseriesCode === timeseriesCode)
    if (matches.length === 0) return failure("missing_series", `${timeseriesCode} (${basis}) is not in the feed`)
    if (matches.length > 1) return failure("duplicate_series", `${timeseriesCode} (${basis}) appears ${matches.length} times`)
    const row = matches[0] as Record<string, unknown>
    if (!isCalendarDate(row.Date)) return failure("bad_date", `${timeseriesCode} Date is not a YYYY-MM-DD calendar date: ${JSON.stringify(row.Date)}`)
    const rate = percentToDecimalFraction(row.Value)
    if (!rate) return failure("bad_value", `${timeseriesCode} Value is not a percent above 0 and below 50 with at most ${MAX_PERCENT_PLACES} decimals: ${JSON.stringify(row.Value)}`)
    observations.push({ basis, timeseriesCode, effectiveDate: row.Date, rate })
  }
  return { ok: true, observations }
}

/** Fetches and parses the feed once: a 15 s timeout, no retry. */
export async function fetchSarbObservations(fetchImpl: typeof fetch = fetch): Promise<SarbFeedResult> {
  let response: Response
  try {
    response = await fetchImpl(SARB_FEED_URL, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(SARB_FEED_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return failure("timeout", `no answer within ${SARB_FEED_TIMEOUT_MS / 1000} s`)
    return failure("network", error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) return failure("http_status", `the feed answered HTTP ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    // The timeout signal also covers reading the body.
    if (error instanceof Error && error.name === "TimeoutError") return failure("timeout", `the body did not arrive within ${SARB_FEED_TIMEOUT_MS / 1000} s`)
    return failure("not_json", "the feed body is not JSON")
  }
  return parseSarbFeed(body)
}
