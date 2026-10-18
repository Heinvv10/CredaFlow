/** SARB's dated change series (PRIME/REPO) and ZARONIA observation periods.
 * HomePageRates dates are publication observations and cannot date a change.
 * Source contract: https://custom.resbank.co.za/SarbWebApi/swagger/index.html
 */
import { sastCalendarDate } from "@/lib/date/sast"
import { toDayNumber } from "./dates"
import { percentToDecimalFraction, SARB_FEED_TIMEOUT_MS, type FeedBasis, type SarbFeedResult, type SarbObservation } from "./sarb-rate-feed"

export const SARB_EFFECTIVE_SERIES = { MRDPRIME: "PRIME", MRDREPOR: "REPO", MMRD855A: "ZARONIA" } as const
export const SARB_HISTORY_URL = "https://custom.resbank.co.za/SarbWebApi/WebIndicators/Shared/GetTimeseriesObservations"

export function parseSarbHistory(body: unknown, basis: FeedBasis, timeseriesCode: string, today = sastCalendarDate(new Date())): SarbFeedResult {
  if (!Array.isArray(body) || body.length === 0) return { ok: false, reason: "bad_shape", detail: `${timeseriesCode}: no dated observations` }
  const observations: SarbObservation[] = []
  const dates = new Set<string>()
  for (const row of body) {
    const period = typeof row === "object" && row !== null ? row.Period : null
    const date = typeof period === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(period) ? period.slice(0, 10) : ""
    try { toDayNumber(date) } catch { return { ok: false, reason: "bad_date", detail: `${timeseriesCode}: invalid Period` } }
    if (date > today) return { ok: false, reason: "future_date", detail: `${timeseriesCode}: future Period` }
    if (dates.has(date)) return { ok: false, reason: "duplicate_series", detail: `${timeseriesCode}: duplicate Period ${date}` }
    dates.add(date)
    const rate = percentToDecimalFraction(row?.Value)
    if (!rate) return { ok: false, reason: "bad_value", detail: `${timeseriesCode}: invalid Value` }
    observations.push({ basis, timeseriesCode, effectiveDate: date, rate })
  }
  observations.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
  return { ok: true, observations }
}

export async function fetchSarbEffectiveObservations(fetchImpl: typeof fetch = fetch): Promise<SarbFeedResult> {
  const today = sastCalendarDate(new Date())
  const observations: SarbObservation[] = []
  for (const [code, basis] of Object.entries(SARB_EFFECTIVE_SERIES)) {
    try {
      const response = await fetchImpl(`${SARB_HISTORY_URL}/${code}/1900-01-01/${today}`, {
        headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(SARB_FEED_TIMEOUT_MS),
      })
      if (!response.ok) return { ok: false, reason: "http_status", detail: `${code}: HTTP ${response.status}` }
      let body: unknown
      try { body = await response.json() } catch { return { ok: false, reason: "not_json", detail: `${code}: invalid JSON` } }
      const result = parseSarbHistory(body, basis, code)
      if (!result.ok) return result
      observations.push(...result.observations)
    } catch (error) {
      return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network", detail: `${code}: history unavailable` }
    }
  }
  return { ok: true, observations }
}
