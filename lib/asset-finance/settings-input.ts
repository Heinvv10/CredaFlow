/**
 * Validation of the tenant-level asset-finance set-up written by ADMIN users:
 * the module switch, payout dual-approval threshold, dealer portal switch and
 * commission clawback window, the tracker position retention (PATCH
 * /api/settings/asset-finance) and the VAT vendor details
 * (PUT /api/asset-finance/vat-config).
 *
 * TenantConfig.assetFinanceLegalWordingApproved is deliberately NOT writable:
 * it is a Confirmation Gate set by CredaFlow once the lender's legal team has
 * approved the agreement wording. A body that names it is refused.
 */
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { MAX_INT, asRecord } from "./input-fields"

export interface AssetFinanceSettingsInput {
  featureAssetFinance?: boolean
  assetPayoutDualApprovalCents?: number
  /** The dealer portal (SLICE5.md part A); the database allows it only on a demo lender. */
  featureDealerPortal?: boolean
  /** Months after booking within which an early settlement or write-off reverses dealer commission (0 = off). */
  dealerCommissionClawbackMonths?: number
  /** Days a tracker position is kept (SLICE5.md part B); the database's CHECK bounds it to 1..365. */
  telematicsPositionRetentionDays?: number
}

export const MAX_CLAWBACK_MONTHS = 60

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
    if (typeof record.featureAssetFinance === "boolean") {
      // Asset finance is built on NCA regimes, s127 and recovery. It can be
      // switched off anywhere, on only inside the NCA's jurisdiction.
      if (record.featureAssetFinance && !isNcaJurisdiction()) {
        errors.featureAssetFinance = "asset finance is an NCA product and is not available to this lender"
      } else {
        data.featureAssetFinance = record.featureAssetFinance
      }
    } else errors.featureAssetFinance = "must be true or false"
  }
  if ("assetPayoutDualApprovalCents" in record) {
    const cents = record.assetPayoutDualApprovalCents
    if (typeof cents === "number" && Number.isInteger(cents) && cents >= 0 && cents <= MAX_INT) {
      data.assetPayoutDualApprovalCents = cents
    } else {
      errors.assetPayoutDualApprovalCents = "must be a whole number of cents from 0 (every payout) upwards"
    }
  }
  if ("featureDealerPortal" in record) {
    if (typeof record.featureDealerPortal === "boolean") data.featureDealerPortal = record.featureDealerPortal
    else errors.featureDealerPortal = "must be true or false"
  }
  if ("dealerCommissionClawbackMonths" in record) {
    const months = record.dealerCommissionClawbackMonths
    if (typeof months === "number" && Number.isInteger(months) && months >= 0 && months <= MAX_CLAWBACK_MONTHS) {
      data.dealerCommissionClawbackMonths = months
    } else {
      errors.dealerCommissionClawbackMonths = `must be a whole number of months from 0 (off) to ${MAX_CLAWBACK_MONTHS}`
    }
  }
  if ("telematicsPositionRetentionDays" in record) {
    const days = record.telematicsPositionRetentionDays
    if (typeof days === "number" && Number.isInteger(days) && days <= MAX_INT && days >= -MAX_INT) data.telematicsPositionRetentionDays = days
    else errors.telematicsPositionRetentionDays = "must be a whole number of days"
  }
  if (Object.keys(errors).length > 0) return { errors }
  if (Object.keys(data).length === 0) {
    return { errors: { body: "send featureAssetFinance, assetPayoutDualApprovalCents, featureDealerPortal, dealerCommissionClawbackMonths and/or telematicsPositionRetentionDays" } }
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
