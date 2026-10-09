// Ordering for the staff capture wizard's product list: retail products
// smallest-first so staff scan from the cheapest option up, with PO Funding
// forced last — it is a commercial facility, not a consumer loan, and sits
// apart from the retail ladder regardless of its amount range. Alphabetical
// order (the previous behaviour) put PO Funding second.
export interface ProductOrderKey {
  productType: string | null
  minAmount: number
  maxAmount: number
}

export function compareProductsForCapture(a: ProductOrderKey, b: ProductOrderKey): number {
  const aLast = a.productType === "PO_FUNDING" ? 1 : 0
  const bLast = b.productType === "PO_FUNDING" ? 1 : 0
  if (aLast !== bLast) return aLast - bLast
  if (a.minAmount !== b.minAmount) return a.minAmount - b.minAmount
  return a.maxAmount - b.maxAmount
}
