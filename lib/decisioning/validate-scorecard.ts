import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import {
  DECLINE_CATEGORY_HINT, Problems, checkScalar, factDefinition, isDeclineCategory, isObject, rejectUnknownKeys,
} from "./validate-common"
import { BAND_ACTIONS, type Scorecard } from "./types"
import type { FactDefinition } from "./facts"

const MAX_CHARACTERISTICS = 20
const MAX_BINS = 20
const MAX_BANDS = 10
const POINT_LIMIT = 1000

const isWhole = (v: unknown, limit = POINT_LIMIT): v is number => typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= limit

function checkBin(raw: unknown, def: FactDefinition, path: string, problems: Problems): void {
  if (!isObject(raw)) return problems.add(path, "expected an object")
  rejectUnknownKeys(raw, ["min", "max", "equals", "in", "points"], path, problems)
  if (!isWhole(raw.points)) problems.add(`${path}.points`, `points are a whole number, ${POINT_LIMIT} at most either way`)
  const tests = ["equals", "in"].filter((k) => k in raw)
  const hasRange = "min" in raw || "max" in raw
  if (tests.length + (hasRange ? 1 : 0) !== 1) return problems.add(path, "a bin tests exactly one of: a min/max range, equals, or in")
  if (hasRange) {
    if (def.type !== "number") return problems.add(path, `a min/max range needs a number fact; ${def.label} is a ${def.type}`)
    for (const key of ["min", "max"] as const) {
      if (key in raw && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]))) problems.add(`${path}.${key}`, "expected a number")
    }
    if (typeof raw.min === "number" && typeof raw.max === "number" && raw.min >= raw.max) problems.add(path, "min must be below max")
  } else if (tests[0] === "equals") {
    checkScalar(raw.equals, def, `${path}.equals`, problems)
  } else if (!Array.isArray(raw.in) || raw.in.length === 0 || raw.in.length > 50) {
    problems.add(`${path}.in`, "a list of 1 to 50 values")
  } else {
    raw.in.forEach((item, i) => checkScalar(item, def, `${path}.in[${i}]`, problems))
  }
}

function checkCharacteristics(raw: unknown, problems: Problems): void {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHARACTERISTICS) {
    return problems.add("scorecard.characteristics", `1 to ${MAX_CHARACTERISTICS} characteristics`)
  }
  const seen = new Set<string>()
  raw.forEach((item, i) => {
    const path = `scorecard.characteristics[${i}]`
    if (!isObject(item)) return problems.add(path, "expected an object")
    rejectUnknownKeys(item, ["field", "bins", "missingPoints"], path, problems)
    if (!isWhole(item.missingPoints)) problems.add(`${path}.missingPoints`, `a whole number, ${POINT_LIMIT} at most either way`)
    const fact = factDefinition(item.field, `${path}.field`, problems)
    if (!fact) return
    if (seen.has(fact.name)) problems.add(`${path}.field`, `${fact.name} is repeated`)
    seen.add(fact.name)
    if (!Array.isArray(item.bins) || item.bins.length === 0 || item.bins.length > MAX_BINS) {
      return problems.add(`${path}.bins`, `1 to ${MAX_BINS} bins`)
    }
    item.bins.forEach((bin, j) => checkBin(bin, fact.def, `${path}.bins[${j}]`, problems))
  })
}

function checkBands(raw: unknown, problems: Problems): void {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BANDS) {
    return problems.add("scorecard.bands", `1 to ${MAX_BANDS} grade bands`)
  }
  const grades = new Set<string>()
  raw.forEach((band, i) => {
    const path = `scorecard.bands[${i}]`
    if (!isObject(band)) return problems.add(path, "expected an object")
    rejectUnknownKeys(band, ["minScore", "grade", "action", "pricingTier", "declineCategory"], path, problems)
    if (!isWhole(band.minScore, 1_000_000)) problems.add(`${path}.minScore`, "a whole number")
    else if (i > 0 && isObject(raw[i - 1]) && isWhole((raw[i - 1] as Record<string, unknown>).minScore, 1_000_000) && band.minScore >= ((raw[i - 1] as Record<string, unknown>).minScore as number)) {
      problems.add(`${path}.minScore`, "bands run strictly descending by minScore")
    }
    if (typeof band.grade !== "string" || !/^[A-Z0-9+-]{1,4}$/.test(band.grade)) problems.add(`${path}.grade`, "1 to 4 characters of A-Z, 0-9, + or -")
    else if (grades.has(band.grade)) problems.add(`${path}.grade`, `grade "${band.grade}" is repeated`)
    else grades.add(band.grade)
    if (!(BAND_ACTIONS as readonly unknown[]).includes(band.action)) problems.add(`${path}.action`, `one of ${BAND_ACTIONS.join(", ")}`)
    if (band.pricingTier !== undefined && (typeof band.pricingTier !== "string" || !/^[A-Za-z0-9_ -]{1,30}$/.test(band.pricingTier))) {
      problems.add(`${path}.pricingTier`, "1 to 30 letters, digits, spaces, hyphens or underscores")
    }
    if (band.action === "DECLINE" && band.declineCategory !== undefined && !isDeclineCategory(band.declineCategory)) {
      problems.add(`${path}.declineCategory`, `needs ${DECLINE_CATEGORY_HINT}`)
    }
    if (band.action !== "DECLINE" && band.declineCategory !== undefined) problems.add(`${path}.declineCategory`, "only a DECLINE band takes a declineCategory")
  })
}

/** Validates untrusted JSON as a scorecard (null: no scorecard). Throws InvalidPayloadError listing every problem. */
export function parseScorecard(raw: unknown): Scorecard | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) throw new InvalidPayloadError(["scorecard: expected an object"])
  const problems = new Problems()
  rejectUnknownKeys(raw, ["baseScore", "characteristics", "bands"], "scorecard", problems)
  if (!isWhole(raw.baseScore, 1_000_000)) problems.add("scorecard.baseScore", "a whole number")
  checkCharacteristics(raw.characteristics, problems)
  checkBands(raw.bands, problems)
  problems.throwIfAny()
  return raw as unknown as Scorecard
}
