import { describe, expect, it } from "vitest"
import { loadHeadlinePremiums, resolveHeadlinePremium } from "./headline-premium"

const band = (lifeType: string, premiumAmount: string, sumAssured = "10000.00") => ({ lifeType, premiumAmount, sumAssured })

describe("resolveHeadlinePremium", () => {
  it("uses the cheapest MAIN_MEMBER band, not the flat column or a cheaper CHILD band", () => {
    const r = resolveHeadlinePremium(118, [band("MAIN_MEMBER", "118.00", "20000.00"), band("MAIN_MEMBER", "62.00"), band("CHILD", "12.00", "5000.00")])
    expect(r).toEqual({ amount: 62, from: true, cover: 10000 })
  })
  it("returns the cover of the cheapest band, never another band's cover", () => {
    const r = resolveHeadlinePremium(118, [
      band("MAIN_MEMBER", "171.00", "20000.00"), band("MAIN_MEMBER", "62.00", "10000.00"), band("MAIN_MEMBER", "249.00", "30000.00"),
    ])
    expect(r.cover).toBe(10000)
  })
  it("keeps the flat price without a rate table", () => {
    expect(resolveHeadlinePremium(118, undefined)).toEqual({ amount: 118, from: false, cover: null })
    expect(resolveHeadlinePremium(118, [])).toEqual({ amount: 118, from: false, cover: null })
  })
  it("falls back to the flat price when a rated product has no MAIN_MEMBER rows", () => {
    expect(resolveHeadlinePremium(118, [band("CHILD", "12.00")])).toEqual({ amount: 118, from: false, cover: null })
  })
})

describe("loadHeadlinePremiums", () => {
  it("prices each product from its newest in-force table and defaults the rest to flat", async () => {
    const prisma = {
      insuranceRateTable: {
        findMany: async () => [
          { productId: "a", bands: [band("MAIN_MEMBER", "70.00")] },
          { productId: "a", bands: [band("MAIN_MEMBER", "50.00")] }, // older version
        ],
      },
    } as never
    const m = await loadHeadlinePremiums(prisma, "t1", [{ id: "a", premiumAmount: 118 }, { id: "b", premiumAmount: 40 }])
    expect(m.get("a")).toEqual({ amount: 70, from: true, cover: 10000 })
    expect(m.get("b")).toEqual({ amount: 40, from: false, cover: null })
  })
})
