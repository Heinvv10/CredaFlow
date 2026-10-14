import type { BusinessEntityType } from "@prisma/client"
import { MAX_FIGURE_CENTS } from "./big-cents"

// Validation of a BusinessEntity create/update body (goal §4.5). Formats are
// checked loosely: the shape of a CIPC or Master's number, not its existence.
// Money is integer cents; the classifier figures need the financial year they
// describe. financialsEvidenceIds is never accepted here — it has its own
// route that checks the documents (app/api/asset-finance/entities/[id]/
// financials-evidence).

export const BUSINESS_ENTITY_TYPES: readonly BusinessEntityType[] = ["COMPANY", "CC", "TRUST", "PARTNERSHIP"]

/** CIPC company / close corporation number: YYYY/NNNNNN/NN. */
export const CIPC_NUMBER = /^(?:18|19|20)\d{2}\/\d{6}\/\d{2}$/
/** Master of the High Court trust number, e.g. "IT1234/2015" or "IT 1234/15 (T)". */
export const TRUST_IT_NUMBER = /^IT ?\d{1,6}\/\d{2,4}(?: ?\(?[A-Z]{1,3}\)?)?$/
/** Partnerships have no statutory number; any reference the lender keeps. */
const FREE_REFERENCE = /^[A-Z0-9][A-Z0-9 /().-]{2,39}$/
/** SA VAT vendor numbers are ten digits starting with 4. */
const VAT_NUMBER = /^4\d{9}$/

export interface BusinessEntityInput {
  type: BusinessEntityType
  legalName: string
  tradingName: string | null
  registrationNumber: string
  mastersReference: string | null
  vatNumber: string | null
  annualTurnover: number | null
  totalAssetValue: number | null
  financialYearEnd: Date | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  province: string | null
  postalCode: string | null
}

export type EntityInputResult = { data: BusinessEntityInput } | { errors: Record<string, string> }

type Body = Record<string, unknown>

function text(body: Body, key: string, errors: Record<string, string>, max: number, required = false): string | null {
  const raw = body[key]
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    if (required) errors[key] = "Required"
    return null
  }
  if (typeof raw !== "string") {
    errors[key] = "Must be text"
    return null
  }
  const value = raw.trim()
  if (value.length > max) errors[key] = `At most ${max} characters`
  return value
}

function cents(body: Body, key: string, errors: Record<string, string>): number | null {
  const raw = body[key]
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    errors[key] = "Must be a whole, non-negative number of cents"
    return null
  }
  // BIGINT columns; the cap keeps every value exact as a JavaScript number.
  if (raw > MAX_FIGURE_CENTS) {
    errors[key] = `Cannot exceed ${MAX_FIGURE_CENTS} cents`
    return null
  }
  return raw
}

function isoDate(body: Body, key: string, errors: Record<string, string>, today: Date): Date | null {
  const raw = body[key]
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    errors[key] = "Must be a date (YYYY-MM-DD)"
    return null
  }
  const date = new Date(`${raw}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    errors[key] = "Not a real date"
    return null
  }
  if (raw > today.toISOString().slice(0, 10)) {
    errors[key] = "A financial year end cannot be in the future"
    return null
  }
  return date
}

function registrationError(type: BusinessEntityType, value: string): string | null {
  switch (type) {
    case "COMPANY":
    case "CC":
      return CIPC_NUMBER.test(value) ? null : "Expected a CIPC number: YYYY/NNNNNN/NN"
    case "TRUST":
      return TRUST_IT_NUMBER.test(value) ? null : "Expected the Master's trust number, e.g. IT1234/2015"
    case "PARTNERSHIP":
      return FREE_REFERENCE.test(value) ? null : "3 to 40 letters, digits, spaces or / ( ) . -"
  }
}

/** Parse and validate a full entity body (create, or update with every field). */
export function parseBusinessEntityInput(body: unknown, today: Date = new Date()): EntityInputResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { errors: { body: "Expected a JSON object" } }
  }
  const b = body as Body
  const errors: Record<string, string> = {}

  const type = b.type
  if (typeof type !== "string" || !(BUSINESS_ENTITY_TYPES as readonly string[]).includes(type)) {
    errors.type = `One of ${BUSINESS_ENTITY_TYPES.join(", ")}`
  }
  const entityType = type as BusinessEntityType

  const legalName = text(b, "legalName", errors, 200, true)
  const tradingName = text(b, "tradingName", errors, 200)
  const registration = text(b, "registrationNumber", errors, 40, true)?.toUpperCase() ?? null
  const masters = text(b, "mastersReference", errors, 40)?.toUpperCase() ?? null
  const vatNumber = text(b, "vatNumber", errors, 10)
  if (vatNumber && !VAT_NUMBER.test(vatNumber)) errors.vatNumber = "Ten digits starting with 4"

  let registrationNumber = ""
  let mastersReference: string | null = null
  if (!errors.type && registration && !errors.registrationNumber) {
    const problem = registrationError(entityType, registration)
    if (problem) errors.registrationNumber = problem
    registrationNumber = registration
  }
  if (!errors.type) {
    if (entityType === "TRUST") {
      // A trust's registration number IS its Master's reference; the column
      // is filled from it unless a separate one is supplied.
      if (masters && !TRUST_IT_NUMBER.test(masters)) errors.mastersReference = "Expected the Master's trust number, e.g. IT1234/2015"
      mastersReference = masters ?? (registrationNumber || null)
    } else if (masters) {
      errors.mastersReference = "Only a trust has a Master's reference"
    }
  }

  const annualTurnover = cents(b, "annualTurnover", errors)
  const totalAssetValue = cents(b, "totalAssetValue", errors)
  const financialYearEnd = isoDate(b, "financialYearEnd", errors, today)
  if ((annualTurnover !== null || totalAssetValue !== null) && !financialYearEnd && !errors.financialYearEnd) {
    errors.financialYearEnd = "Required with turnover or asset value"
  }
  if (financialYearEnd && annualTurnover === null && totalAssetValue === null && !errors.annualTurnover && !errors.totalAssetValue) {
    errors.financialYearEnd = "Only meaningful with a turnover or asset value"
  }

  const addressLine1 = text(b, "addressLine1", errors, 200)
  const addressLine2 = text(b, "addressLine2", errors, 200)
  const city = text(b, "city", errors, 100)
  const province = text(b, "province", errors, 100)
  const postalCode = text(b, "postalCode", errors, 10)
  if (postalCode && !/^\d{4}$/.test(postalCode)) errors.postalCode = "Four digits"

  if (Object.keys(errors).length > 0) return { errors }
  return {
    data: {
      type: entityType,
      // legalName is required: a missing one is in errors above.
      legalName: legalName ?? "",
      tradingName,
      registrationNumber,
      mastersReference,
      vatNumber,
      annualTurnover,
      totalAssetValue,
      financialYearEnd,
      addressLine1,
      addressLine2,
      city,
      province,
      postalCode,
    },
  }
}

/** True when an update changes a figure the financials evidence attests to. */
export function financialsChanged(
  before: { annualTurnover: number | null; totalAssetValue: number | null; financialYearEnd: Date | null },
  after: { annualTurnover: number | null; totalAssetValue: number | null; financialYearEnd: Date | null },
): boolean {
  return (
    before.annualTurnover !== after.annualTurnover ||
    before.totalAssetValue !== after.totalAssetValue ||
    (before.financialYearEnd?.getTime() ?? null) !== (after.financialYearEnd?.getTime() ?? null)
  )
}
