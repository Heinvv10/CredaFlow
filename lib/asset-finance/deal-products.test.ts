import { describe, expect, it } from "vitest"
import { ASSET_FINANCE_PRODUCT_WHERE } from "./deal-products"

describe("asset-finance deal products", () => {
  it("are the active ASSET_FINANCE products, whether or not default interest is configured", () => {
    expect(ASSET_FINANCE_PRODUCT_WHERE).toEqual({ active: true, productType: "ASSET_FINANCE" })
    expect(ASSET_FINANCE_PRODUCT_WHERE).not.toHaveProperty("nonNcaDefaultInterestMargin")
  })
})
