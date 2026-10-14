import type { AssetClass, SupplierBankAccountStatus, ValuationSource } from "@prisma/client"

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
