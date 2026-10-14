import type { Prisma } from "@prisma/client"

// A product may deliberately disable default interest. That does not make it
// ineligible for an asset-finance deal.
export const ASSET_FINANCE_PRODUCT_WHERE = {
  active: true,
} satisfies Prisma.LoanProductWhereInput
