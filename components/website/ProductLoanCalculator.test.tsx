import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { LivePricing } from "@/lib/public-loan-products"

const { usePricing } = vi.hoisted(() => ({ usePricing: vi.fn() }))
vi.mock("@/lib/use-live-pricing", () => ({ useLivePricing: usePricing }))

import { ProductLoanCalculator } from "./ProductLoanCalculator"

const live: LivePricing = {
  interestRatePm: 0.05, interestModel: "REDUCING_BALANCE" as LivePricing["interestModel"],
  initiationFeePct: 0.1, initiationFeeMax: 1000, monthlyServiceFee: 60,
  minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 180,
}

describe("ProductLoanCalculator product filtering", () => {
  beforeEach(() => usePricing.mockReset())

  it("offers only products the tenant has a live row for", () => {
    usePricing.mockReturnValue({ pricing: { personal: live }, loading: false })
    const html = renderToStaticMarkup(<ProductLoanCalculator variant="full" />)
    expect(html).toContain("Personal loan")
    expect(html).not.toContain("Invoice discounting")
    expect(html).not.toContain("Purchase order funding")
  })

  it("says so when the tenant has no live products", () => {
    usePricing.mockReturnValue({ pricing: {}, loading: false })
    const html = renderToStaticMarkup(<ProductLoanCalculator variant="full" />)
    expect(html).toContain("No loan products are available yet.")
    expect(html).not.toContain("Invoice discounting")
  })

  it("shows nothing selectable while loading", () => {
    usePricing.mockReturnValue({ pricing: {}, loading: true })
    const html = renderToStaticMarkup(<ProductLoanCalculator variant="full" />)
    expect(html).toContain("Loading products")
    expect(html).not.toContain("<button")
  })
})
