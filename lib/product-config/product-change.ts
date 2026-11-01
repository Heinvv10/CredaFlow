/**
 * A change to a loan product as a second person approves it (spec 2.1.3): its creation, an edit of its row, or its deactivation.
 * Every field is in the unit the row stores. A product under the product engine still changes its limits, price and fees by
 * a new version (lib/product-engine/change-handlers.ts); this request carries what a version does not.
 */
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { Problems, isObject, rejectUnknownKeys } from "@/lib/decisioning/validate-common"
import { PRODUCT_TYPES, type ProductTypeName } from "./product-kind"

export const LOAN_PRODUCT_KIND = "LOAN_PRODUCT"

export interface ProductFields {
  code: string
  name: string
  productType: ProductTypeName
  minAmount: number
  maxAmount: number
  minTermDays: number
  maxTermDays: number
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMax: number
  monthlyServiceFee: number
  active: boolean
  /** Absent leaves the stored value; null clears it (lib/product-config/non-nca-arrears.ts). */
  nonNcaDefaultInterestMargin?: string | null
  nonNcaCollectionFeeCents?: number | null
}

export type LoanProductPayload =
  | { action: "CREATE"; reason: string; product: ProductFields }
  | { action: "UPDATE"; reason: string; productId: string; product: ProductFields }
  | { action: "DEACTIVATE"; reason: string; productId: string }

const FIELD_KEYS = [
  "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel", "initiationFeeModel", "initiationFeePct",
  "initiationFeeMax", "monthlyServiceFee", "active", "nonNcaDefaultInterestMargin", "nonNcaCollectionFeeCents",
] as const

const INT4_MAX = 2_147_483_647
const isCount = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= INT4_MAX

function parseFields(raw: unknown, problems: Problems): ProductFields | null {
  if (!isObject(raw)) {
    problems.add("payload.product", "the product's fields")
    return null
  }
  rejectUnknownKeys(raw, FIELD_KEYS, "payload.product", problems)
  for (const key of ["code", "name"] as const) {
    if (typeof raw[key] !== "string" || raw[key].trim().length < 1 || raw[key].length > 120) problems.add(`payload.product.${key}`, "1 to 120 characters")
  }
  if (!(PRODUCT_TYPES as readonly unknown[]).includes(raw.productType)) problems.add("payload.product.productType", `one of ${PRODUCT_TYPES.join(", ")}`)
  for (const key of ["minAmount", "maxAmount", "minTermDays", "maxTermDays"] as const) {
    if (!isCount(raw[key], 1)) problems.add(`payload.product.${key}`, "a positive whole number")
  }
  if (isCount(raw.minAmount, 1) && isCount(raw.maxAmount, 1) && (raw.maxAmount as number) < (raw.minAmount as number)) problems.add("payload.product.maxAmount", "not below the minimum")
  if (isCount(raw.minTermDays, 1) && isCount(raw.maxTermDays, 1) && (raw.maxTermDays as number) < (raw.minTermDays as number)) problems.add("payload.product.maxTermDays", "not below the minimum")
  if (typeof raw.interestRatePm !== "number" || !Number.isFinite(raw.interestRatePm) || raw.interestRatePm < 0 || raw.interestRatePm >= 1) problems.add("payload.product.interestRatePm", "a monthly rate from 0 up to (not including) 1")
  if (raw.interestModel !== "FLAT" && raw.interestModel !== "REDUCING_BALANCE" && raw.interestModel !== "DAILY_ACCRUAL") problems.add("payload.product.interestModel", "FLAT, REDUCING_BALANCE or DAILY_ACCRUAL")
  if (raw.initiationFeeModel !== "FLAT_PCT" && raw.initiationFeeModel !== "NCA_REG42") problems.add("payload.product.initiationFeeModel", "FLAT_PCT or NCA_REG42")
  if (typeof raw.initiationFeePct !== "number" || !Number.isFinite(raw.initiationFeePct) || raw.initiationFeePct < 0) problems.add("payload.product.initiationFeePct", "a share of the principal, 0 or more")
  for (const key of ["initiationFeeMax", "monthlyServiceFee"] as const) {
    if (!isCount(raw[key], 0)) problems.add(`payload.product.${key}`, "a whole number of cents, 0 or more")
  }
  if (typeof raw.active !== "boolean") problems.add("payload.product.active", "true or false")
  const margin = raw.nonNcaDefaultInterestMargin
  if (margin !== undefined && margin !== null && typeof margin !== "string") problems.add("payload.product.nonNcaDefaultInterestMargin", "a decimal string, or null")
  const fee = raw.nonNcaCollectionFeeCents
  if (fee !== undefined && fee !== null && !isCount(fee, 0)) problems.add("payload.product.nonNcaCollectionFeeCents", "a whole number of cents, or null")
  return raw as unknown as ProductFields
}

export function parseLoanProductChange(raw: unknown): LoanProductPayload {
  if (!isObject(raw)) throw new InvalidPayloadError(["payload: expected an object"])
  const problems = new Problems()
  rejectUnknownKeys(raw, ["action", "reason", "productId", "product"], "payload", problems)
  if (raw.action !== "CREATE" && raw.action !== "UPDATE" && raw.action !== "DEACTIVATE") problems.add("payload.action", "CREATE, UPDATE or DEACTIVATE")
  if (typeof raw.reason !== "string" || raw.reason.trim().length < 5 || raw.reason.length > 500) problems.add("payload.reason", "5 to 500 characters: why the product changes")
  if (raw.action !== "CREATE" && (typeof raw.productId !== "string" || raw.productId.length === 0)) problems.add("payload.productId", "the product this changes")
  if (raw.action === "CREATE" && raw.productId !== undefined) problems.add("payload.productId", "a new product has none")
  if (raw.action === "DEACTIVATE" && raw.product !== undefined) problems.add("payload.product", "a deactivation carries no fields")
  const product = raw.action === "DEACTIVATE" ? null : parseFields(raw.product, problems)
  problems.throwIfAny()
  const reason = (raw.reason as string).trim()
  const fields: ProductFields | null = product && { ...product, code: product.code.trim(), name: product.name.trim() }
  if (raw.action === "CREATE") return { action: "CREATE", reason, product: fields! }
  if (raw.action === "UPDATE") return { action: "UPDATE", reason, productId: raw.productId as string, product: fields! }
  return { action: "DEACTIVATE", reason, productId: raw.productId as string }
}
