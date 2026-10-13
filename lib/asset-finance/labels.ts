import type { AssetDealStatus, BusinessEntityType, EntityDocumentType, EntityRole, NcaRegime, PaymentMethod } from "@prisma/client"
import { BALANCE_WAIVED_LABEL } from "@/lib/payments/waiver"
import type { NcaRuleId } from "./nca-classifier"
import {
  NCA_JURISTIC_THRESHOLD_CENTS,
  NCA_LARGE_AGREEMENT_THRESHOLD_CENTS,
  NCA_TRUST_MIN_TRUSTEES_FOR_JURISTIC,
} from "./nca-thresholds"

// Display labels for the asset-finance enums, shared by staff and portal UI.
// Screens print these, never a raw enum or rule id.

export const ENTITY_TYPE_LABELS: Record<BusinessEntityType, string> = {
  COMPANY: "Company (Pty) Ltd",
  CC: "Close corporation",
  TRUST: "Trust",
  PARTNERSHIP: "Partnership",
}

export const ENTITY_ROLE_LABELS: Record<EntityRole, string> = {
  DIRECTOR: "Director",
  MEMBER: "Member / partner",
  TRUSTEE: "Trustee",
  AUTHORISED_SIGNATORY: "Authorised signatory",
  SURETY: "Surety",
  BENEFICIAL_OWNER: "Beneficial owner",
}

export const ENTITY_DOCUMENT_LABELS: Record<EntityDocumentType, string> = {
  CIPC_REGISTRATION: "CIPC registration (CoR)",
  TRUST_DEED: "Trust deed",
  LETTERS_OF_AUTHORITY: "Letters of Authority",
  RESOLUTION: "Resolution",
  AFS: "Annual financial statements",
  MANAGEMENT_ACCOUNTS: "Management accounts",
  BANK_STATEMENT: "Bank statement",
  SUPPLIER_INVOICE: "Supplier invoice",
  INSURANCE_NOTING: "Insurance noting",
  TRACKER_CERTIFICATE: "Tracker certificate",
  DELIVERY_ACCEPTANCE: "Delivery and acceptance",
  NATIS_DOCUMENT: "eNaTIS document",
  VALUATION: "Valuation",
  SIGNED_AGREEMENT: "Signed agreement",
  SIGNED_SURETYSHIP: "Signed suretyship",
  SIGNED_RESOLUTION: "Signed resolution",
  OTHER: "Other",
}

/** "UNDER_REVIEW" → "Under review". */
export function statusLabel(status: string): string {
  const words = status.toLowerCase().replaceAll("_", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const NCA_REGIME_LABELS: Record<NcaRegime, string> = {
  NCA: "Regulated by the NCA",
  NON_NCA: "Not regulated by the NCA",
}

const JURISTIC_THRESHOLD = `R${NCA_JURISTIC_THRESHOLD_CENTS / 100_000_000}m`
const LARGE_AGREEMENT = `R${NCA_LARGE_AGREEMENT_THRESHOLD_CENTS / 100_000}k`

/** The classifier's rule ids (./nca-classifier.ts) in plain English. */
export const NCA_RULE_LABELS: Record<NcaRuleId, string> = {
  TRUST_FEW_NATURAL_TRUSTEES: `Trust with fewer than ${NCA_TRUST_MIN_TRUSTEES_FOR_JURISTIC} trustees, all natural persons`,
  TRUST_UNEVIDENCED: "Trust without Letters of Authority or recorded trustees",
  FINANCIALS_UNPROVEN: "Turnover and asset value not proven by verified financial statements",
  JURISTIC_OVER_THRESHOLD: `Juristic person over the ${JURISTIC_THRESHOLD} threshold`,
  LARGE_AGREEMENT: `Large agreement of ${LARGE_AGREEMENT} or more`,
  JURISTIC_SMALL_AGREEMENT: `Juristic person under ${JURISTIC_THRESHOLD} borrowing less than ${LARGE_AGREEMENT}`,
}

function isRuleId(value: string): value is NcaRuleId {
  return Object.hasOwn(NCA_RULE_LABELS, value)
}

/** A stored rule id as plain English; an unknown value is returned as is. */
export function ncaRuleLabel(rule: string): string {
  return isRuleId(rule) ? NCA_RULE_LABELS[rule] : rule
}

/**
 * A recorded decision reason for display: any rule id in it becomes plain
 * English. The NCA refusal reason is stored in plain English already
 * (deal-submit.ts ncaRefusalReason); a staff reason may name a rule id.
 */
export function describeDecisionReason(reason: string): string {
  return reason.replace(/\b[A-Z]+(?:_[A-Z]+)+\b/g, (token) => ncaRuleLabel(token))
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  EFT: "EFT",
  CASH: "Cash",
  DEBIT_ORDER: "Debit order",
  CARD: "Card",
  WAIVER: BALANCE_WAIVED_LABEL,
}

export function paymentMethodLabel(method: string): string {
  return Object.hasOwn(PAYMENT_METHOD_LABELS, method) ? PAYMENT_METHOD_LABELS[method as PaymentMethod] : statusLabel(method)
}

/** Supplier bank account types (supplier-input.ts BANK_ACCOUNT_TYPES). */
export const BANK_ACCOUNT_TYPE_LABELS: Record<string, string> = {
  CHEQUE: "Cheque",
  SAVINGS: "Savings",
  TRANSMISSION: "Transmission",
}

export function bankAccountTypeLabel(type: string): string {
  return Object.hasOwn(BANK_ACCOUNT_TYPE_LABELS, type) ? BANK_ACCOUNT_TYPE_LABELS[type] : statusLabel(type)
}

/** Director and trustee bureau check outcomes (deal-bureau-results.ts). */
export const BUREAU_OUTCOME_LABELS: Record<"stored" | "skipped" | "failed", string> = {
  stored: "Stored",
  skipped: "Skipped",
  failed: "Failed",
}

/**
 * The credit-decision panel's line when no decision can be recorded: the
 * deal's final state, or what has to happen first.
 */
export function dealDecisionNote(status: AssetDealStatus): string {
  switch (status) {
    case "DRAFT":
      return "Submit the deal to decide it."
    case "SUBMITTED":
    case "REFERRED":
      return "A user with the decide permission records the decision."
    case "REFUSED_NCA":
      return "Refused: NCA applies. A refused deal takes no credit decision."
    case "CANCELLED":
      return "Cancelled. The deal is closed and takes no credit decision."
    default:
      return `Final state: ${statusLabel(status)}.`
  }
}

/** The deal API's field names (deal-input.ts, structure.ts) as the form labels them. */
export const DEAL_FIELD_LABELS: Record<string, string> = {
  entityId: "Borrower",
  assetId: "Asset",
  supplierId: "Supplier",
  productId: "Product",
  depositCents: "Deposit",
  tradeInCents: "Trade-in",
  financedFeesCents: "Financed fees",
  balloonCents: "Balloon",
  firstDueDate: "First due date",
  startDate: "Start date",
  rateBasis: "Rate basis",
  fixedRate: "Fixed rate",
  rateMargin: "Margin",
  vatDeferralPeriodIndex: "VAT repaid in period",
  vatDeferralPeriods: "VAT repaid in period",
  preset: "Structure",
  "preset.kind": "Structure",
  "preset.periods": "Months",
  "preset.skipFirst": "Months with no payment",
  "preset.seasonMonths": "Season months",
  "preset.seasonWeight": "Season weight",
  "preset.offWeight": "Off-season weight",
  "preset.months": "Paying months",
  "preset.steps": "Steps",
  weights: "Payment weights",
  "financed amount": "Financed amount",
}

/** "balloonCents" → "Balloon"; "weights[3]" → "Payment weights"; unknown keys as given. */
export function dealFieldLabel(key: string): string {
  const base = key.replace(/\[\d+\]$/, "").replace(/\.(periodIndex|vatCents)$/, "")
  if (Object.hasOwn(DEAL_FIELD_LABELS, key)) return DEAL_FIELD_LABELS[key]
  return Object.hasOwn(DEAL_FIELD_LABELS, base) ? DEAL_FIELD_LABELS[base] : key
}

/** An API `{ fields }` map as one sentence per field: "Balloon must be …". */
export function describeFieldErrors(fields: Record<string, string>): string[] {
  return Object.entries(fields).map(([key, message]) => `${dealFieldLabel(key)} ${message}`)
}

/** A solver message "balloonCents: must be …" → "Balloon must be …"; other text unchanged. */
export function describeSolverError(message: string): string {
  const match = /^([A-Za-z][\w. \[\]]*?): (.+)$/.exec(message)
  if (!match) return message
  const label = dealFieldLabel(match[1])
  return label === match[1] ? message : `${label} ${match[2]}`
}
