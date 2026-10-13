/**
 * Validation of a financed asset (POST/PATCH /api/asset-finance/assets) and of
 * an asset valuation (POST /api/asset-finance/assets/[id]/valuations).
 * Money is integer cents. Serial numbers and VINs are stored trimmed and upper
 * case; the database's duplicate check compares them the same way.
 */
import type { AssetClass, ValuationSource } from "@prisma/client"
import { toDayNumber } from "./dates"
import {
  asRecord, MAX_INT, readBool, readEnum, readInt, readText,
  type Errors, type Fields,
} from "./input-fields"

export const ASSET_CLASSES = [
  "PASSENGER_VEHICLE", "LIGHT_COMMERCIAL", "TRUCK", "TRAILER", "TRACTOR", "TLB",
  "EXCAVATOR", "GRADER", "FRONT_END_LOADER", "FORKLIFT", "OTHER_YELLOW",
] as const satisfies readonly AssetClass[]

export const VALUATION_SOURCES = ["DEALER", "AUCTIONEER", "ASSESSOR", "INTERNAL"] as const satisfies readonly ValuationSource[]

export interface AssetFields {
  assetClass: AssetClass
  make: string
  model: string
  year: number
  serialNumber: string
  vin: string | null
  engineNumber: string | null
  registrationNumber: string | null
  hours: number | null
  odometerKm: number | null
  cashPriceExclVatCents: number
  vatCents: number
  residualCents: number | null
  natisTitleholder: string | null
  trackerProvider: string | null
  trackerId: string | null
  insurer: string | null
  policyNumber: string | null
  lenderNotedConfirmed: boolean
}

/**
 * The fields that describe what was sold and for how much. Once the asset is
 * on a booked loan they are part of the contract and its tax invoice, so they
 * can no longer be edited; insurance, tracker and usage fields can.
 */
export const CONTRACT_FIELDS = [
  "assetClass", "make", "model", "year", "serialNumber", "vin", "engineNumber",
  "cashPriceExclVatCents", "vatCents", "residualCents",
] as const satisfies readonly (keyof AssetFields)[]

type Parsed<T> = { data: T } | { errors: Errors }

function parseAsset(body: unknown, partial: boolean): Parsed<Fields> {
  const record = asRecord(body)
  if (!record) return { errors: { body: "must be a JSON object" } }
  const out: Fields = {}
  const errors: Errors = {}
  const required = !partial
  readEnum(record, "assetClass", out, errors, { required, values: ASSET_CLASSES })
  readText(record, "make", out, errors, { required, nullable: false, max: 100 })
  readText(record, "model", out, errors, { required, nullable: false, max: 100 })
  readInt(record, "year", out, errors, { required, nullable: false, min: 1950, max: new Date().getUTCFullYear() + 1 })
  readText(record, "serialNumber", out, errors, { required, nullable: false, max: 64, upper: true })
  readText(record, "vin", out, errors, { required: false, nullable: true, max: 64, upper: true })
  readText(record, "engineNumber", out, errors, { required: false, nullable: true, max: 64, upper: true })
  readText(record, "registrationNumber", out, errors, { required: false, nullable: true, max: 32, upper: true })
  readInt(record, "hours", out, errors, { required: false, nullable: true, min: 0, max: MAX_INT })
  readInt(record, "odometerKm", out, errors, { required: false, nullable: true, min: 0, max: MAX_INT })
  readInt(record, "cashPriceExclVatCents", out, errors, { required, nullable: false, min: 1, max: MAX_INT })
  readInt(record, "vatCents", out, errors, { required, nullable: false, min: 0, max: MAX_INT })
  readInt(record, "residualCents", out, errors, { required: false, nullable: true, min: 0, max: MAX_INT })
  for (const key of ["natisTitleholder", "trackerProvider", "trackerId", "insurer", "policyNumber"]) {
    readText(record, key, out, errors, { required: false, nullable: true, max: 120 })
  }
  readBool(record, "lenderNotedConfirmed", out, errors)

  const price = out.cashPriceExclVatCents
  const vat = out.vatCents
  const residual = out.residualCents
  if (typeof price === "number" && typeof vat === "number" && typeof residual === "number" && residual > price + vat) {
    errors.residualCents = "cannot exceed the cash price including VAT"
  }
  if (Object.keys(errors).length > 0) return { errors }
  if (partial && Object.keys(out).length === 0) return { errors: { body: "has no asset fields to change" } }
  return { data: out }
}

/** A new asset: every required field present. */
export function parseAssetCreate(body: unknown): Parsed<AssetFields> {
  const parsed = parseAsset(body, false)
  if ("errors" in parsed) return parsed
  const defaults = {
    vin: null, engineNumber: null, registrationNumber: null, hours: null, odometerKm: null,
    residualCents: null, natisTitleholder: null, trackerProvider: null, trackerId: null,
    insurer: null, policyNumber: null, lenderNotedConfirmed: false,
  }
  return { data: { ...defaults, ...parsed.data } as AssetFields }
}

/** A change to an asset: only the fields present. */
export function parseAssetUpdate(body: unknown): Parsed<Partial<AssetFields>> {
  const parsed = parseAsset(body, true)
  if ("errors" in parsed) return parsed
  return { data: parsed.data as Partial<AssetFields> }
}

export interface ValuationFields {
  valuedOn: string // YYYY-MM-DD
  source: ValuationSource
  valuerName: string
  amountCents: number
  documentId: string | null
}

/** A valuation: dated no later than `today` (YYYY-MM-DD), positive amount. */
export function parseValuation(body: unknown, today: string): Parsed<ValuationFields> {
  const record = asRecord(body)
  if (!record) return { errors: { body: "must be a JSON object" } }
  const out: Fields = {}
  const errors: Errors = {}
  readEnum(record, "source", out, errors, { required: true, values: VALUATION_SOURCES })
  readText(record, "valuerName", out, errors, { required: true, nullable: false, max: 120 })
  readInt(record, "amountCents", out, errors, { required: true, nullable: false, min: 1, max: MAX_INT })
  readText(record, "documentId", out, errors, { required: false, nullable: true, max: 64 })
  const valuedOn = typeof record.valuedOn === "string" ? record.valuedOn : ""
  try {
    if (toDayNumber(valuedOn, "valuedOn") > toDayNumber(today, "today")) errors.valuedOn = "cannot be in the future"
  } catch {
    errors.valuedOn = "must be a calendar date YYYY-MM-DD"
  }
  if (Object.keys(errors).length > 0) return { errors }
  return { data: { valuedOn, documentId: null, ...out } as ValuationFields }
}

/**
 * The 409 message for a unique violation (Prisma P2002) on the book-wide
 * duplicate indexes, or null if the violation is something else. Prisma names
 * an expression index by its expressions, e.g. `upper(btrim(vin))`.
 */
export function duplicateAssetMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const { code, meta } = error as { code?: unknown; meta?: { target?: unknown } }
  if (code !== "P2002") return null
  const target = Array.isArray(meta?.target) ? meta.target.join(",") : String(meta?.target ?? "")
  if (target.includes("serialNumber")) {
    return "An asset with this serial number is already on the book and has not been released"
  }
  if (/\bvin\b/.test(target)) {
    return "An asset with this VIN is already on the book and has not been released"
  }
  return null
}
