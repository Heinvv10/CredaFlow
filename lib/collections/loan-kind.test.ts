import { describe, expect, it } from "vitest"
import { collectionsLoanKind } from "./loan-kind"

describe("collectionsLoanKind", () => {
  // Fair Score audit 2026-10-16: an asset-finance loan on a product whose
  // productType is PERSONAL was listed as "Personal".
  it("names an asset-finance contract by its contract type, not its product type", () => {
    expect(collectionsLoanKind({ contractType: "INSTALMENT_SALE", product: { productType: "PERSONAL" } })).toBe("Instalment sale")
    expect(collectionsLoanKind({ contractType: "FINANCE_LEASE", product: { productType: "PERSONAL" } })).toBe("Finance lease")
    expect(collectionsLoanKind({ contractType: "FULL_MAINTENANCE_LEASE", product: { productType: "PERSONAL" } })).toBe("Full-maintenance lease")
  })

  it("names a consumer loan by its product type", () => {
    expect(collectionsLoanKind({ contractType: "LOAN", product: { productType: "PERSONAL" } })).toBe("Personal")
    expect(collectionsLoanKind({ contractType: "LOAN", product: { productType: "MICRO" } })).toBe("Micro")
    expect(collectionsLoanKind({ product: { productType: "PO_FUNDING" } })).toBe("PO Fund")
    expect(collectionsLoanKind({ product: { productType: "ASSET_FINANCE" } })).toBe("Asset finance")
  })
})
