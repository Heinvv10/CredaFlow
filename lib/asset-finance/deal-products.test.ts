import { describe, expect, it } from "vitest"
import { ASSET_FINANCE_PRODUCT_WHERE } from "./deal-products"

describe("asset-finance deal products", () => {
  it("includes active products whose default-interest margin is disabled", () => {
    expect(ASSET_FINANCE_PRODUCT_WHERE).toEqual({ active: true })
    expect(ASSET_FINANCE_PRODUCT_WHERE).not.toHaveProperty("nonNcaDefaultInterestMargin")
  })
})
