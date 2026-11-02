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
  SALARY_BACKED: "Salary-backed (check-off)",
  SME: "SME",
  GROUP: "Group",
  REVOLVING: "Revolving credit",
}

export type ProductTypeName = ProductType

export const PRODUCT_TYPES = Object.keys(PRODUCT_TYPE_LABELS) as ProductType[]

/**
 * The types an NCA lender may not configure: the NCA paperwork and its credit-type classification know none of them, and each
 * needs the lender's legal sign-off first. Originated by staff, who capture the facts each needs (lib/product-types); no
 * customer channel offers them. Mortgage is out of scope.
 */
export const NON_NCA_PRODUCT_TYPES = ["SALARY_BACKED", "SME", "GROUP", "REVOLVING"] as const satisfies readonly ProductType[]

export const isNonNcaProductType = (type: string): boolean => (NON_NCA_PRODUCT_TYPES as readonly string[]).includes(type)

/** What each of those types makes the lender do (lib/product-types/rules.ts), shown where it is chosen. */
export const PRODUCT_TYPE_HINT: Partial<Record<ProductType, string>> = {
  SALARY_BACKED: "An application names the employer and payroll number of a salaried borrower; the loan appears on that employer's monthly deduction list.",
  SME: "An application names the business, its registration number and its turnover, for a business purpose. The applicant is the borrower of record.",
  GROUP: "An application names a lending group the borrower belongs to; it is refused while any member is in arrears. Members are not liable for each other's loans.",
  REVOLVING: "The product's maximum amount is each borrower's limit: a new draw is refused above it, and repaid principal frees it. Each draw is its own application and loan.",
}

/** The products a consumer (portal, website, staff consumer application, CRM, lender API) may apply for. */
export const CONSUMER_PRODUCT_WHERE = {
  productType: { not: "ASSET_FINANCE" },
} satisfies Prisma.LoanProductWhereInput

/**
 * The products a customer channel (portal, website, lender API) may offer: the consumer ones that are not on a repayment
 * structure (lib/product-engine). Those channels show and schedule monthly instalments only, so a weekly, fortnightly, graced,
 * interest-only or bullet product is originated by staff until they follow the structure. The salary-backed, SME, group and
 * revolving types need facts only staff capture.
 */
export const CUSTOMER_PRODUCT_WHERE = {
  productType: { notIn: ["ASSET_FINANCE", ...NON_NCA_PRODUCT_TYPES] },
  repaymentStructured: false,
} satisfies Prisma.LoanProductWhereInput
