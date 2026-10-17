import type { AssetDealStatus, ContractType, ReferenceRateBasis } from "@prisma/client"
import type { AssetContractType, StructurePresetName } from "./deal-input"
import { statusLabel } from "./labels"

// Display labels for asset-finance deals, shared by the staff pages.

export type Tone = "neutral" | "success" | "warning" | "danger" | "info"

export const DEAL_STATUS_TONE: Record<AssetDealStatus, Tone> = {
  DRAFT: "neutral",
  SUBMITTED: "info",
  REFERRED: "warning",
  REFUSED_NCA: "danger",
  APPROVED: "success",
  DECLINED: "danger",
  CONTRACTED: "info",
  BOOKED: "success",
  CANCELLED: "neutral",
}

/** "REFUSED_NCA" → "Refused: NCA applies"; other statuses as statusLabel. */
export function dealStatusLabel(status: AssetDealStatus): string {
  return status === "REFUSED_NCA" ? "Refused: NCA applies" : statusLabel(status)
}

export const CONTRACT_TYPE_LABELS: Record<AssetContractType, string> = {
  INSTALMENT_SALE: "Instalment sale",
  FINANCE_LEASE: "Finance lease",
  OPERATING_LEASE: "Operating lease",
  FULL_MAINTENANCE_LEASE: "Full-maintenance lease",
}

/** The agreement type of a deal; a plain LOAN (never a deal) reads "Loan". */
export function contractTypeLabel(type: ContractType): string {
  return type === "LOAN" ? "Loan" : CONTRACT_TYPE_LABELS[type]
}

/** The party who takes the asset: a lessee on any lease, a borrower on an instalment sale. */
export function counterpartyLabel(type: ContractType): "Lessee" | "Borrower" {
  return type === "FINANCE_LEASE" || type === "OPERATING_LEASE" || type === "FULL_MAINTENANCE_LEASE" ? "Lessee" : "Borrower"
}

export const PRESET_LABELS: Record<StructurePresetName, string> = {
  MONTHLY: "Equal monthly",
  ANNUAL_SEASONAL: "Annual seasonal",
  BIANNUAL: "Twice a year",
  SKIP_N: "Skip the first months",
  STEP_UP: "Step-up",
}

export const RATE_BASIS_LABELS: Record<ReferenceRateBasis, string> = {
  FIXED: "Fixed",
  PRIME: "Prime",
  REPO: "Repo",
  JIBAR: "JIBAR",
  ZARONIA: "ZARONIA",
  LENDER_BASE: "Lender base rate",
}

/** "0.1175" → "11.75%". */
export function ratePercent(decimal: string): string {
  return `${(Number(decimal) * 100).toFixed(2)}%`
}

/** The rate as typed by staff ("11.75", "-0.5") → the API's decimal string ("0.1175"); null if malformed. */
export function percentToDecimal(input: string, allowNegative: boolean): string | null {
  const match = (allowNegative ? /^(-?)(\d{1,2})(?:\.(\d{1,4}))?$/ : /^()(\d{1,2})(?:\.(\d{1,4}))?$/).exec(input.trim())
  if (!match) return null
  const [, sign, whole, fraction = ""] = match
  // Shift the decimal point two places left on the digits, no float maths.
  const digits = `${whole.padStart(2, "0")}${fraction.padEnd(4, "0")}`
  const decimal = `0.${digits}`.replace(/0+$/, "").replace(/\.$/, "")
  return decimal === "0" ? "0" : `${sign}${decimal}`
}
