import { afterEach, describe, expect, it } from "vitest"
import { formatRandsWhole } from "@/lib/public-loan-products"
import { activeCurrencySymbol } from "@/lib/utils"
import { resetActiveJurisdiction, setActiveJurisdiction } from "./active"

afterEach(() => resetActiveJurisdiction())

describe("the currency symbol follows the lender", () => {
  it("is R for ZA and M for LS", () => {
    expect(activeCurrencySymbol()).toBe("R")
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(activeCurrencySymbol()).toBe("M")
  })

  it("marketing copy keeps its shape: R10,000 becomes M10,000", () => {
    expect(formatRandsWhole(1_000_000)).toBe("R10,000")
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(formatRandsWhole(1_000_000)).toBe("M10,000")
  })
})
