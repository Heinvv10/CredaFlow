// Product kinds (ProductType): the consumer loan products and the asset-finance
// products. An ASSET_FINANCE product is offered only on an asset-finance deal
// (lib/asset-finance/deal-products.ts); every consumer list and consumer
// application path excludes it (Fair Score audit E4). Client-safe.
import type { Prisma, ProductType } from "@prisma/client"

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  MICRO: "Micro",
  PERSONAL: "Personal",
  PO_FUNDING: "PO Funding",
  ASSET_FINANCE: "Asset finance",
}

/** The products a consumer (portal, website, staff consumer application, CRM, lender API) may apply for. */
export const CONSUMER_PRODUCT_WHERE = {
  productType: { not: "ASSET_FINANCE" },
} satisfies Prisma.LoanProductWhereInput
