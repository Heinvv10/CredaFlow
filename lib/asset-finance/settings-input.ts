/**
 * Validation of the tenant-level asset-finance set-up written by ADMIN users:
 * the module switch and payout dual-approval threshold
 * (PATCH /api/settings/asset-finance) and the VAT vendor details
 * (PUT /api/asset-finance/vat-config).
 *
 * TenantConfig.assetFinanceLegalWordingApproved is deliberately NOT writable:
 * it is a Confirmation Gate set by CredaFlow once the lender's legal team has
 * approved the agreement wording. A body that names it is refused.
 */
import { MAX_INT, asRecord } from "./input-fields"

export interface AssetFinanceSettingsInput {
  featureAssetFinance?: boolean
  assetPayoutDualApprovalCents?: number
}

export type Parsed<T> = { data: T } | { errors: Record<string, string> }

export const LEGAL_WORDING_FIELD = "assetFinanceLegalWordingApproved"

export function parseAssetFinanceSettings(body: unknown): Parsed<AssetFinanceSettingsInput> {
  const record = asRecord(body)
  if (!record) return { errors: { body: "must be a JSON object" } }
  const errors: Record<string, string> = {}
  const data: AssetFinanceSettingsInput = {}
  if (LEGAL_WORDING_FIELD in record) {
    errors[LEGAL_WORDING_FIELD] = "is set by CredaFlow once the lender's legal team approves the agreement wording"
  }
  if ("featureAssetFinance" in record) {
    if (typeof record.featureAssetFinance === "boolean") data.featureAssetFinance = record.featureAssetFinance
    else errors.featureAssetFinance = "must be true or false"
  }
  if ("assetPayoutDualApprovalCents" in record) {
    const cents = record.assetPayoutDualApprovalCents
    if (typeof cents === "number" && Number.isInteger(cents) && cents >= 0 && cents <= MAX_INT) {
      data.assetPayoutDualApprovalCents = cents
    } else {
      errors.assetPayoutDualApprovalCents = "must be a whole number of cents from 0 (every payout) upwards"
    }
  }
  if (Object.keys(errors).length > 0) return { errors }
  if (data.featureAssetFinance === undefined && data.assetPayoutDualApprovalCents === undefined) {
    return { errors: { body: "send featureAssetFinance and/or assetPayoutDualApprovalCents" } }
  }
  return { data }
}

export interface VatConfigInput {
  vatNumber: string
  registeredName: string
  address: string
}

/** A South African VAT vendor number: ten digits, the first a 4. */
export const SA_VAT_NUMBER = /^4\d{9}$/

export function parseVatConfig(body: unknown): Parsed<VatConfigInput> {
  const record = asRecord(body)
  if (!record) return { errors: { body: "must be a JSON object" } }
  const errors: Record<string, string> = {}
  const text = (key: string, max: number): string => {
    const raw = record[key]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (value.length === 0) errors[key] = "is required"
    else if (value.length > max) errors[key] = `must be at most ${max} characters`
    return value
  }
  const vatNumber = typeof record.vatNumber === "string" ? record.vatNumber.replace(/\s/g, "") : ""
  if (!SA_VAT_NUMBER.test(vatNumber)) errors.vatNumber = "must be ten digits starting with 4"
  const registeredName = text("registeredName", 200)
  const address = text("address", 500)
  if (Object.keys(errors).length > 0) return { errors }
  return { data: { vatNumber, registeredName, address } }
}
