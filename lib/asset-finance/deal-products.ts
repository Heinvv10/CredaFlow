import type { Prisma } from "@prisma/client"

// An asset-finance deal takes an active ASSET_FINANCE product only (Fair Score
// audit E4; lib/product-config/product-kind.ts). A product may deliberately
// disable default interest (a null NON_NCA margin): that does not make it
// ineligible.
export const ASSET_FINANCE_PRODUCT_WHERE = {
  active: true,
  productType: "ASSET_FINANCE",
} satisfies Prisma.LoanProductWhereInput
