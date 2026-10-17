/**
 * The short "kind of loan" label on a collections row. An asset-finance
 * contract is named by its contract type: its product row may carry a consumer
 * productType (the audit saw a plant instalment sale shown as "Personal").
 */
const CONTRACT_KIND: Record<string, string> = {
  INSTALMENT_SALE: "Instalment sale",
  FINANCE_LEASE: "Finance lease",
  OPERATING_LEASE: "Operating lease",
  FULL_MAINTENANCE_LEASE: "Full-maintenance lease",
}

const PRODUCT_KIND: Record<string, string> = {
  MICRO: "Micro",
  PERSONAL: "Personal",
  PO_FUNDING: "PO Fund",
  ASSET_FINANCE: "Asset finance",
}

export function productKindLabel(productType: string): string {
  return PRODUCT_KIND[productType] ?? productType
}

export function collectionsLoanKind(loan: { contractType?: string | null; product: { productType: string } }): string {
  return (loan.contractType && CONTRACT_KIND[loan.contractType]) || productKindLabel(loan.product.productType)
}
