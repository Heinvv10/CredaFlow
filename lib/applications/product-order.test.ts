import { describe, expect, it } from "vitest"
import { compareProductsForCapture, type ProductOrderKey } from "./product-order"

// Four retail products, in the alphabetical order the loader's
// `orderBy: { name: "asc" }` returns them (the pre-fix on-screen order).
// Amounts are rand, as ApplicationProduct carries them.
const MICRO = { name: "Micro Loan", productType: "MICRO", minAmount: 2_000, maxAmount: 10_000 }
const PO_FUNDING = { name: "PO Funding", productType: "PO_FUNDING", minAmount: 10_000, maxAmount: 500_000 }
const PERSONAL = { name: "Personal Loan", productType: "PERSONAL", minAmount: 2_000, maxAmount: 100_000 }
const STARTER = { name: "Starter Loan", productType: "MICRO", minAmount: 500, maxAmount: 2_000 }

function names(products: Array<ProductOrderKey & { name: string }>): string[] {
  return [...products].sort(compareProductsForCapture).map((p) => p.name)
}

describe("compareProductsForCapture", () => {
  it("orders the retail ladder smallest-first with PO Funding last", () => {
    expect(names([MICRO, PO_FUNDING, PERSONAL, STARTER])).toEqual([
      "Starter Loan",
      "Micro Loan",
      "Personal Loan",
      "PO Funding",
    ])
  })

  it("forces PO Funding last even when its range is the smallest", () => {
    // Guards the PO_FUNDING rule itself: with these amounts a pure
    // smallest-first sort would put PO Funding FIRST.
    const tinyPo = { name: "PO Funding", productType: "PO_FUNDING", minAmount: 100, maxAmount: 200 }
    expect(names([MICRO, tinyPo, STARTER])).toEqual(["Starter Loan", "Micro Loan", "PO Funding"])
  })

  it("breaks equal minimums by the smaller maximum", () => {
    // MICRO and PERSONAL share minAmount 2 000; the narrower range wins.
    expect(names([PERSONAL, MICRO])).toEqual(["Micro Loan", "Personal Loan"])
  })
})
