import type { AssetClass, AssetDealStatus, SupplierBankAccountStatus, ValuationSource } from "@prisma/client"
import { dealStatusLabel } from "./deal-labels"

// A deal in one of these no longer holds its asset (./deal-create.ts CLOSED_DEAL_STATUSES; client-safe copy, tested equal).
export const ASSET_FREEING_DEAL_STATUSES: readonly AssetDealStatus[] = ["REFUSED_NCA", "DECLINED", "CANCELLED"]

// Display labels for the asset-register and supplier enums (staff UI).

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  PASSENGER_VEHICLE: "Passenger vehicle",
  LIGHT_COMMERCIAL: "Light commercial vehicle",
  TRUCK: "Truck",
  TRAILER: "Trailer",
  TRACTOR: "Tractor",
  TLB: "TLB",
  EXCAVATOR: "Excavator",
  GRADER: "Grader",
  FRONT_END_LOADER: "Front-end loader",
  FORKLIFT: "Forklift",
  OTHER_YELLOW: "Other yellow machinery",
}

/**
 * Where an asset stands on the lender's book: released (its deal closed),
 * on book (a deal on it was booked), on an open deal, or available (no deal
 * yet, or only closed ones). `releasedAt` is formatted by the caller.
 */
export function assetBookStatus(asset: { releasedAt: string | null; deals: { status: AssetDealStatus }[] }): string {
  if (asset.releasedAt) return `Released ${asset.releasedAt}`
  if (asset.deals.some((d) => d.status === "BOOKED")) return "On book"
  const open = asset.deals.find((d) => !ASSET_FREEING_DEAL_STATUSES.includes(d.status))
  return open ? `On a deal (${dealStatusLabel(open.status)})` : "Available"
}

export const VALUATION_SOURCE_LABELS: Record<ValuationSource, string> = {
  DEALER: "Dealer",
  AUCTIONEER: "Auctioneer",
  ASSESSOR: "Assessor",
  INTERNAL: "Internal",
}

export const BANK_ACCOUNT_STATUS_LABELS: Record<SupplierBankAccountStatus, string> = {
  PENDING: "Awaiting approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SUPERSEDED: "Superseded",
}
