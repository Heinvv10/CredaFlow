/** Validation of the lender's IFRS 9 policy (a PUT body, merged over what is stored). */
import { DEFAULT_SETTINGS, type Ifrs9Settings } from "./types"

type NumberKey = "sicrDpdOver" | "defaultDpd" | "stage2ProbationMonths" | "stage3ProbationMonths" | "suspensionDpd"
type BooleanKey = "enabled" | "restructuredIsSicr" | "debtReviewIsSicr" | "suspensionEnabled" | "suspendOnStage3"

const NUMBER_RANGES: Record<NumberKey, [number, number]> = {
  sicrDpdOver: [1, 3650], defaultDpd: [1, 3650], suspensionDpd: [1, 3650], stage2ProbationMonths: [0, 60], stage3ProbationMonths: [0, 60],
}
const BOOLEAN_KEYS: readonly BooleanKey[] = ["enabled", "restructuredIsSicr", "debtReviewIsSicr", "suspensionEnabled", "suspendOnStage3"]
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export function parseSettingsInput(body: unknown, current: Ifrs9Settings): { ok: true; settings: Ifrs9Settings } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "The body must be a JSON object" }
  const input = body as Record<string, unknown>
  const known = new Set<string>(Object.keys(DEFAULT_SETTINGS))
  for (const key of Object.keys(input)) if (!known.has(key)) return { ok: false, error: `${key} is not an IFRS 9 setting` }
  const next: Ifrs9Settings = { ...current }
  for (const key of BOOLEAN_KEYS) {
    if (!(key in input)) continue
    if (typeof input[key] !== "boolean") return { ok: false, error: `${key} must be true or false` }
    next[key] = input[key]
  }
  for (const key of Object.keys(NUMBER_RANGES) as NumberKey[]) {
    if (!(key in input)) continue
    const [min, max] = NUMBER_RANGES[key]
    const value = input[key]
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return { ok: false, error: `${key} must be a whole number from ${min} to ${max}` }
    next[key] = value
  }
  if ("effectiveFromMonth" in input) {
    const value = input.effectiveFromMonth
    if (value !== null && !(typeof value === "string" && MONTH.test(value))) return { ok: false, error: "effectiveFromMonth must be yyyy-mm or null" }
    next.effectiveFromMonth = value as string | null
  }
  if (next.sicrDpdOver >= next.defaultDpd) return { ok: false, error: "sicrDpdOver must be below defaultDpd: Stage 2 starts before Stage 3" }
  return { ok: true, settings: next }
}

/**
 * Switching IFRS 9 on without naming the first month it governs would hold every earlier, unclosed month to a run
 * that cannot exist: it takes effect from the month it is switched on.
 */
export function withEffectiveMonth(next: Ifrs9Settings, current: Ifrs9Settings, today: string): Ifrs9Settings {
  return !current.enabled && next.enabled && next.effectiveFromMonth === null ? { ...next, effectiveFromMonth: today.slice(0, 7) } : next
}
