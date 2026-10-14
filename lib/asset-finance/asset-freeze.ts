/**
 * Which asset fields may still change (review item 3). What the agreement
 * describes is fixed from the credit approval: once any deal on the asset is
 * APPROVED, CONTRACTED or BOOKED, its class, make, model, year, identifiers,
 * registration and price are frozen. A fact a payout checklist item attests
 * is frozen once that item is confirmed: the insurance (and the lender-noted
 * flag), the tracker id and the eNaTIS titleholder. The database refuses the
 * same writes (guardFinancedAssetIdentity, migration
 * 20261013114100_asset_finance_review_assets); this is the readable refusal.
 */
import type { PayoutChecklistItemKind } from "@prisma/client"
import type { AssetFields } from "./asset-input"
import type { SigningTx } from "./signing-prepare"

export const IDENTITY_FIELDS = [
  "assetClass", "make", "model", "year", "serialNumber", "vin", "engineNumber", "registrationNumber",
  "cashPriceExclVatCents", "vatCents",
] as const satisfies readonly (keyof AssetFields)[]

export const ATTESTED_FIELDS = {
  INSURANCE_NOTES_LENDER: ["lenderNotedConfirmed", "insurer", "policyNumber"],
  TRACKER_CONFIRMED: ["trackerId"],
  NATIS_TITLEHOLDER: ["natisTitleholder"],
} as const satisfies Partial<Record<PayoutChecklistItemKind, readonly (keyof AssetFields)[]>>

type AttestingItem = keyof typeof ATTESTED_FIELDS

export interface AssetFreezeState {
  /** A deal on the asset is APPROVED, CONTRACTED or BOOKED. */
  onApprovedDeal: boolean
  /** Checklist items confirmed on any deal of the asset. */
  confirmedItems: readonly PayoutChecklistItemKind[]
}

/** The fields in `changes` that may no longer change, with why; empty when the edit may go ahead. */
export function frozenAssetChanges(changes: Partial<AssetFields>, state: AssetFreezeState): { field: string; reason: string }[] {
  const out: { field: string; reason: string }[] = []
  if (state.onApprovedDeal) {
    for (const field of IDENTITY_FIELDS) if (field in changes) out.push({ field, reason: "the asset is on an approved deal" })
  }
  for (const item of Object.keys(ATTESTED_FIELDS) as AttestingItem[]) {
    if (!state.confirmedItems.includes(item)) continue
    for (const field of ATTESTED_FIELDS[item]) if (field in changes) out.push({ field, reason: `attested on the payout checklist (${item})` })
  }
  return out
}

export async function loadAssetFreezeState(tx: SigningTx, tenantId: string, assetId: string): Promise<AssetFreezeState> {
  const deals = await tx.assetFinanceDeal.findMany({
    where: { tenantId, assetId },
    select: { status: true, checklist: { where: { confirmedAt: { not: null } }, select: { item: true } } },
  })
  return {
    onApprovedDeal: deals.some((d) => d.status === "APPROVED" || d.status === "CONTRACTED" || d.status === "BOOKED"),
    confirmedItems: deals.flatMap((d) => d.checklist.map((c) => c.item)),
  }
}
