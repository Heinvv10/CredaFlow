import { describe, expect, it } from "vitest"
import { formatLtv, goodsAdvanceCents, ltvBps } from "./ltv"

describe("goods advance and LTV against a guide value", () => {
  it("advances the cash price incl. VAT less the deposit and the trade-in", () => {
    expect(goodsAdvanceCents({ cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000, depositCents: 17_250_000, tradeInCents: 5_000_000 })).toBe(150_250_000)
    expect(goodsAdvanceCents({ cashPriceExclVatCents: 100, vatCents: 15, depositCents: 0, tradeInCents: 0 })).toBe(115)
  })

  it("never advances less than nothing", () => {
    expect(goodsAdvanceCents({ cashPriceExclVatCents: 100, vatCents: 15, depositCents: 100, tradeInCents: 100 })).toBe(0)
  })

  it("is the advance over the value in basis points, half up; no value, no LTV", () => {
    expect(ltvBps(150_250_000, 120_000_000)).toBe(12_521) // 125.208 %
    expect(ltvBps(1, 3)).toBe(3_333)
    expect(ltvBps(2, 3)).toBe(6_667)
    expect(ltvBps(1, 20_000)).toBe(1) // 0.5 bp rounds up
    expect(ltvBps(0, 3)).toBe(0)
    expect(ltvBps(5, 0)).toBeNull()
  })

  it("reads as a percentage to two decimals", () => {
    expect(formatLtv(12_521)).toBe("125.21%")
    expect(formatLtv(8_000)).toBe("80.00%")
    expect(formatLtv(null)).toBe("—")
  })
})
