import type { RecoveryCostType } from "@prisma/client"

export const COST_TYPE_LABELS: Record<RecoveryCostType, string> = {
  TOWING: "Towing and transport",
  STORAGE: "Storage",
  VALUATION: "Valuation",
  REPAIRS: "Repairs and reconditioning",
  ADVERTISING: "Advertising",
  AUCTION_COMMISSION: "Auction commission",
  SHERIFF: "Sheriff's fees",
  INSURANCE: "Insurance",
  LEGAL_TAXED: "Legal costs (taxed)",
  LEGAL_CONTRACTUAL: "Legal costs (contractual)",
  OTHER: "Other costs",
}

export const COST_TYPES = Object.keys(COST_TYPE_LABELS) as RecoveryCostType[]
