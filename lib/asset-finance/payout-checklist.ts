/**
 * The payout gate's rules (goal §4.10, DESIGN D8). Pure: no database.
 *
 * REQUIREMENT TABLE. Every PayoutChecklistItemKind is required for every
 * asset contract (instalment sale, finance lease, operating and
 * full-maintenance lease), except NATIS_TITLEHOLDER, which is required
 * only when the asset carries a registration number (an unregistered
 * excavator has no eNaTIS record). The SQL twin is
 * payoutChecklistRequiredKinds (migration 20261013113000); the checklist
 * insert and the payout insert both read it, so the two must agree
 * (./payout-checklist.test.ts holds this list equal to the enum).
 *
 * EVIDENCE. Each non-signing item names an EntityDocument of the deal, of the
 * types below, uploaded by staff and not deleted (guardPayoutChecklistItem).
 * The supplier's bank confirmation has no document type of its own; it is
 * filed as a bank statement or "other". The three signing items have no
 * document: their evidence is the deal's DealSigner rows, every one satisfied
 * (the route re-checks; guardAssetDealContract required it for CONTRACTED).
 *
 * PAYOUT AMOUNT. What the supplier is still owed: the asset's cash price
 * including VAT, less the deposit and the trade-in (which the supplier
 * receives from the borrower directly). Financed fees are the lender's and
 * are not paid out. guardPayout refuses any other amount. A lease has no
 * deposit or trade-in (AssetFinanceDeal_lease_terms_shape): the lessor pays
 * the full cash price.
 *
 * LEASES. The lessor owns the asset: on a registered vehicle the eNaTIS owner,
 * not only the titleholder, must be the lender (guardPayoutChecklistItem), and
 * the insurance notes the lender as owner. The labels say so (checklistLabel).
 */
import type { $Enums, ContractType, EntityDocumentType, PayoutChecklistItemKind } from "@prisma/client"
import { identifierMatchesAsset } from "./asset-identifier"

export const CHECKLIST_KINDS = [
  "SIGNED_AGREEMENT",
  "SIGNED_SURETYSHIPS",
  "SIGNED_RESOLUTION",
  "SUPPLIER_INVOICE_MATCHES_ASSET",
  "SUPPLIER_BANK_VERIFIED",
  "INSURANCE_NOTES_LENDER",
  "TRACKER_CONFIRMED",
  "DELIVERY_AND_ACCEPTANCE",
  "NATIS_TITLEHOLDER",
] as const satisfies readonly $Enums.PayoutChecklistItemKind[]

export const SIGNING_ITEMS: readonly PayoutChecklistItemKind[] = ["SIGNED_AGREEMENT", "SIGNED_SURETYSHIPS", "SIGNED_RESOLUTION"]

export const CHECKLIST_LABELS: Record<PayoutChecklistItemKind, string> = {
  SIGNED_AGREEMENT: "Agreement signed by every authorised signatory",
  SIGNED_SURETYSHIPS: "Suretyship signed by every surety",
  SIGNED_RESOLUTION: "Resolution signed by every authorised signatory",
  SUPPLIER_INVOICE_MATCHES_ASSET: "Supplier invoice in the lender's name; serial/VIN matches the asset",
  SUPPLIER_BANK_VERIFIED: "Supplier bank account verified (bank confirmation on file)",
  INSURANCE_NOTES_LENDER: "Insurance notes the lender's interest",
  TRACKER_CONFIRMED: "Tracker fitted and confirmed",
  DELIVERY_AND_ACCEPTANCE: "Delivery and acceptance signed",
  NATIS_TITLEHOLDER: "eNaTIS titleholder is the lender",
}

export const CHECKLIST_EVIDENCE_TYPES: Record<PayoutChecklistItemKind, readonly EntityDocumentType[]> = {
  SIGNED_AGREEMENT: [],
  SIGNED_SURETYSHIPS: [],
  SIGNED_RESOLUTION: [],
  SUPPLIER_INVOICE_MATCHES_ASSET: ["SUPPLIER_INVOICE"],
  SUPPLIER_BANK_VERIFIED: ["BANK_STATEMENT", "OTHER"],
  INSURANCE_NOTES_LENDER: ["INSURANCE_NOTING"],
  TRACKER_CONFIRMED: ["TRACKER_CERTIFICATE"],
  DELIVERY_AND_ACCEPTANCE: ["DELIVERY_ACCEPTANCE"],
  NATIS_TITLEHOLDER: ["NATIS_DOCUMENT"],
}

/**
 * Every type a deal's evidence upload offers and its route accepts (one list,
 * so the dropdown cannot drift from the validation). LEGAL_DOCUMENT is on it
 * because a surety's consent letter is deal evidence (surety-consent.ts reads
 * a staff LEGAL_DOCUMENT on the deal) and this upload is the only place staff
 * can file one; the portal never shows that type (portal-access.ts). VALUATION
 * is on it because an individual lessee's valuation has no other upload path.
 */
export const DEAL_EVIDENCE_DOC_TYPES: readonly EntityDocumentType[] = [
  ...new Set<EntityDocumentType>(["LEGAL_DOCUMENT", "VALUATION", ...CHECKLIST_KINDS.flatMap((k) => CHECKLIST_EVIDENCE_TYPES[k])]),
]

export interface ChecklistAsset {
  serialNumber: string
  vin: string | null
  registrationNumber: string | null
  natisTitleholder: string | null
  natisOwner?: string | null
  trackerId: string | null
  lenderNotedConfirmed: boolean
}

const present = (value: string | null): boolean => value !== null && value.trim() !== ""

/** The checklist a contract needs; the order is the display order. */
const LEASES: readonly ContractType[] = ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"]

const LEASE_LABELS: Partial<Record<PayoutChecklistItemKind, string>> = {
  INSURANCE_NOTES_LENDER: "Insurance notes the lender as owner of the leased asset",
  NATIS_TITLEHOLDER: "eNaTIS owner and titleholder are the lender",
}

/** The item's label for this contract: a lease's ownership items say owner. */
export function checklistLabel(item: PayoutChecklistItemKind, contractType: ContractType): string {
  return (LEASES.includes(contractType) ? LEASE_LABELS[item] : undefined) ?? CHECKLIST_LABELS[item]
}

export function requiredChecklistKinds(contractType: ContractType, asset: Pick<ChecklistAsset, "registrationNumber">): PayoutChecklistItemKind[] {
  if (contractType !== "INSTALMENT_SALE" && contractType !== "FINANCE_LEASE" && !LEASES.includes(contractType)) {
    throw new RangeError(`No payout checklist is defined for ${contractType}`)
  }
  return CHECKLIST_KINDS.filter((kind) => kind !== "NATIS_TITLEHOLDER" || present(asset.registrationNumber))
}

/** Upper case, trimmed, inner whitespace runs as one space (SQL payoutNormalisedName). */
export function normaliseName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase()
}

/** The typed serial (or VIN) is the asset's, as the duplicate checks compare them (./asset-identifier.ts). */
export function serialAttestationMatches(typed: string, asset: Pick<ChecklistAsset, "serialNumber" | "vin">): boolean {
  return identifierMatchesAsset(typed, asset)
}

/**
 * Why `item` cannot be confirmed against the asset as it stands, or null when
 * it can. Mirrors the asset checks of guardPayoutChecklistItem; the serial
 * attestation and the signing state are checked by the caller.
 */
export function assetBlocker(item: PayoutChecklistItemKind, asset: ChecklistAsset, lenderLegalName: string | null, lease = false): string | null {
  switch (item) {
    case "INSURANCE_NOTES_LENDER":
      return asset.lenderNotedConfirmed ? null : "Record on the asset that the insurer has noted the lender's interest first"
    case "TRACKER_CONFIRMED":
      return present(asset.trackerId) ? null : "Record the asset's tracker id first"
    case "NATIS_TITLEHOLDER":
      if (!present(asset.registrationNumber)) return "The asset has no registration number; no eNaTIS confirmation is needed"
      if (!lenderLegalName) return "The lender's legal name is not configured"
      if (asset.natisTitleholder === null || normaliseName(asset.natisTitleholder) !== normaliseName(lenderLegalName)) {
        return `The asset's eNaTIS titleholder must be the lender, ${lenderLegalName}`
      }
      if (lease && (!asset.natisOwner || normaliseName(asset.natisOwner) !== normaliseName(lenderLegalName))) {
        return `A leased asset's eNaTIS owner must be the lender, ${lenderLegalName}`
      }
      return null
    default:
      return null
  }
}

export interface PayoutDealAmounts {
  cashPriceExclVatCents: number
  vatCents: number
  depositCents: number
  tradeInCents: number
}

/** The supplier payout: cash price incl. VAT − deposit − trade-in (header). */
export function payoutAmountCents(deal: PayoutDealAmounts): number {
  return deal.cashPriceExclVatCents + deal.vatCents - deal.depositCents - deal.tradeInCents
}

/** At or above the tenant threshold a second, different user approves (guardPayout). */
export function needsDualApproval(amountCents: number, thresholdCents: number): boolean {
  return amountCents >= thresholdCents
}
