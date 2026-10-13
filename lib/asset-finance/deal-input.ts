/**
 * Validation of an asset-finance deal body: POST /api/asset-finance/deals
 * (create) and POST /api/asset-finance/deals/preview (structure only).
 *
 * Money is integer cents within INT4 (the deal columns). Rates are annual
 * decimal strings with at most 6 places (DECIMAL(9,6)): a fixed rate from 0
 * to below 1, a margin over the reference from −1 to below 1 (prime minus a
 * margin is common). The structure is a preset with its parameters; the
 * weights it generates are stored with the preset's name. Calendar presets
 * take the month of firstDueDate as period 0's month.
 */
import type { ReferenceRateBasis } from "@prisma/client"
import { toDayNumber } from "./dates"
import { asRecord, MAX_INT, readEnum, readInt, readText, type Errors, type Fields } from "./input-fields"
import { annualSeasonal, biannual, monthly, skipN, stepUp, type WeightStep } from "./structure-presets"

export const STRUCTURE_PRESETS = ["MONTHLY", "ANNUAL_SEASONAL", "BIANNUAL", "SKIP_N", "STEP_UP"] as const
export type StructurePresetName = (typeof STRUCTURE_PRESETS)[number]

export const RATE_BASES = ["FIXED", "PRIME", "REPO", "JIBAR", "ZARONIA", "LENDER_BASE"] as const satisfies readonly ReferenceRateBasis[]

/** Longest structure accepted: ten years of monthly periods. */
export const MAX_PERIODS = 120

const FIXED_RATE = /^0(\.\d{1,6})?$/
const MARGIN = /^-?0(\.\d{1,6})?$/

export interface RateTerms {
  basis: ReferenceRateBasis
  margin: string | null // reference bases only
  fixedRate: string | null // FIXED only
}

export interface StructureTerms {
  depositCents: number
  tradeInCents: number
  financedFeesCents: number
  balloonCents: number
  preset: StructurePresetName
  weights: number[]
  firstDueDate: string
  vatDeferralPeriodIndex: number | null
  rate: RateTerms
}

export interface DealPreviewInput {
  assetId: string
  terms: StructureTerms
}

export interface DealCreateInput extends DealPreviewInput {
  entityId: string
  supplierId: string
  productId: string
}

type Result<T> = { data: T } | { errors: Errors }

function numberList(raw: unknown, label: string, errors: Errors): number[] | null {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "number")) {
    errors[label] = "must be a list of numbers"
    return null
  }
  return raw as number[]
}

function stepList(raw: unknown, errors: Errors): WeightStep[] | null {
  const valid = Array.isArray(raw) && raw.every((step) => {
    const s = asRecord(step)
    return s !== null && typeof s.fromPeriod === "number" && typeof s.weight === "number"
  })
  if (!valid) {
    errors["preset.steps"] = "must be a list of { fromPeriod, weight }"
    return null
  }
  return (raw as Fields[]).map((s) => ({ fromPeriod: s.fromPeriod as number, weight: s.weight as number }))
}

/** The preset's weights, generated from its parameters; firstDueDate fixes the calendar. */
function presetWeights(raw: unknown, firstDueDate: string | null, errors: Errors): { preset: StructurePresetName; weights: number[] } | null {
  const body = asRecord(raw)
  if (!body) {
    errors.preset = "is required: { kind, periods, … }"
    return null
  }
  const out: Fields = {}
  const own: Errors = {}
  readEnum(body, "kind", out, own, { required: true, values: STRUCTURE_PRESETS })
  readInt(body, "periods", out, own, { required: true, nullable: false, min: 1, max: MAX_PERIODS })
  for (const [key, message] of Object.entries(own)) errors[`preset.${key}`] = message
  const kind = out.kind as StructurePresetName | undefined
  const n = out.periods as number | undefined
  if (kind === undefined || n === undefined) return null
  const startMonth = firstDueDate === null ? null : Number(firstDueDate.slice(5, 7))
  try {
    switch (kind) {
      case "MONTHLY":
        return { preset: kind, weights: monthly(n) }
      case "SKIP_N":
        return { preset: kind, weights: skipN(n, body.skipFirst as number) }
      case "STEP_UP": {
        const steps = stepList(body.steps, errors)
        return steps && { preset: kind, weights: stepUp(n, steps) }
      }
      case "ANNUAL_SEASONAL": {
        const months = numberList(body.seasonMonths, "preset.seasonMonths", errors)
        if (!months || startMonth === null) return null
        return { preset: kind, weights: annualSeasonal(n, startMonth, months, body.seasonWeight as number, body.offWeight as number) }
      }
      case "BIANNUAL": {
        const months = numberList(body.months, "preset.months", errors)
        if (!months || startMonth === null) return null
        if (months.length !== 2) {
          errors["preset.months"] = "must be exactly two months"
          return null
        }
        return { preset: kind, weights: biannual(n, [months[0], months[1]], startMonth) }
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    errors.preset = error.message
    return null
  }
}

function readRate(body: Fields, errors: Errors): RateTerms | null {
  const out: Fields = {}
  readEnum(body, "rateBasis", out, errors, { required: true, values: RATE_BASES })
  const basis = out.rateBasis as ReferenceRateBasis | undefined
  if (!basis) return null
  const text = (key: string) => (typeof body[key] === "string" || typeof body[key] === "number" ? String(body[key]) : null)
  const margin = text("rateMargin")
  const fixedRate = text("fixedRate")
  if (basis === "FIXED") {
    if (margin !== null) errors.rateMargin = "must be empty for a fixed rate"
    if (fixedRate === null || !FIXED_RATE.test(fixedRate)) {
      errors.fixedRate = "is required for a fixed rate: an annual decimal from 0 to below 1, e.g. 0.1350"
      return null
    }
    return errors.rateMargin ? null : { basis, margin: null, fixedRate }
  }
  if (fixedRate !== null) errors.fixedRate = "must be empty for a reference-linked rate"
  if (margin === null || !MARGIN.test(margin)) {
    errors.rateMargin = "is required for a reference-linked rate: an annual decimal from -1 to below 1, e.g. 0.0150"
    return null
  }
  return errors.fixedRate ? null : { basis, margin, fixedRate: null }
}

function readFirstDueDate(body: Fields, errors: Errors, today: string): string | null {
  const raw = body.firstDueDate
  try {
    if (typeof raw !== "string") throw new RangeError("missing")
    toDayNumber(raw, "firstDueDate")
  } catch {
    errors.firstDueDate = "must be a calendar date YYYY-MM-DD"
    return null
  }
  if (raw <= today) {
    errors.firstDueDate = "must be after today"
    return null
  }
  return raw
}

/** The structure part shared by preview and create. `today` is the SAST calendar date. */
export function parseDealPreview(body: unknown, today: string): Result<DealPreviewInput> {
  const record = asRecord(body)
  if (!record) return { errors: { body: "must be a JSON object" } }
  const errors: Errors = {}
  const out: Fields = {}
  readText(record, "assetId", out, errors, { required: true, nullable: false, max: 64 })
  for (const key of ["depositCents", "tradeInCents", "financedFeesCents", "balloonCents"]) {
    if (record[key] === undefined) out[key] = 0
    else readInt(record, key, out, errors, { required: false, nullable: false, min: 0, max: MAX_INT })
  }
  readInt(record, "vatDeferralPeriodIndex", out, errors, { required: false, nullable: true, min: 0, max: MAX_PERIODS - 1 })
  const firstDueDate = readFirstDueDate(record, errors, today)
  const structure = presetWeights(record.preset, firstDueDate, errors)
  const rate = readRate(record, errors)
  if (Object.keys(errors).length > 0 || !structure || !rate || !firstDueDate) return { errors }
  return {
    data: {
      assetId: out.assetId as string,
      terms: {
        depositCents: out.depositCents as number,
        tradeInCents: out.tradeInCents as number,
        financedFeesCents: out.financedFeesCents as number,
        balloonCents: out.balloonCents as number,
        preset: structure.preset,
        weights: structure.weights,
        firstDueDate,
        vatDeferralPeriodIndex: (out.vatDeferralPeriodIndex as number | null | undefined) ?? null,
        rate,
      },
    },
  }
}

export function parseDealCreate(body: unknown, today: string): Result<DealCreateInput> {
  const preview = parseDealPreview(body, today)
  const record = asRecord(body) ?? {}
  const errors: Errors = "errors" in preview ? { ...preview.errors } : {}
  const out: Fields = {}
  for (const key of ["entityId", "supplierId", "productId"]) {
    readText(record, key, out, errors, { required: true, nullable: false, max: 64 })
  }
  if ("errors" in preview || Object.keys(errors).length > 0) return { errors }
  return {
    data: {
      ...preview.data,
      entityId: out.entityId as string,
      supplierId: out.supplierId as string,
      productId: out.productId as string,
    },
  }
}
