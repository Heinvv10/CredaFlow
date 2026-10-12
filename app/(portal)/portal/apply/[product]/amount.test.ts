import { describe, expect, it } from "vitest"
import { creditLifePremiumForAmount, validAmountCents } from "./amount"

const product = { minAmount: 200_000, maxAmount: 10_000_000 }

describe("validAmountCents", () => {
  it("accepts an in-range amount, including the bounds", () => {
    expect(validAmountCents(product, "5000")).toBe(500_000)
    expect(validAmountCents(product, "2000")).toBe(200_000)
    expect(validAmountCents(product, "100000")).toBe(10_000_000)
  })

  it.each(["", "   ", "abc", "1999", "100001", "-5000", "0", "Infinity", "1e300", "3000000000000000"])(
    "rejects %j",
    (input) => {
      expect(validAmountCents(product, input)).toBeNull()
    },
  )

  it("treats blank as no amount even when the product minimum is 0", () => {
    expect(validAmountCents({ minAmount: 0, maxAmount: 10_000_000 }, "")).toBeNull()
    expect(validAmountCents({ minAmount: 0, maxAmount: 10_000_000 }, "  ")).toBeNull()
  })

  it("rejects an absurd amount even when the product range is also absurd", () => {
    const wide = { minAmount: 1, maxAmount: Number.MAX_SAFE_INTEGER }
    expect(validAmountCents(wide, "1e300")).toBeNull()
    expect(validAmountCents(wide, "99999999999999999")).toBeNull()
  })
})

describe("creditLifePremiumForAmount", () => {
  it("is 0 and does not throw without a valid amount", () => {
    expect(() => creditLifePremiumForAmount(null)).not.toThrow()
    expect(creditLifePremiumForAmount(null)).toBe(0)
  })

  it("computes the premium for a valid amount", () => {
    expect(creditLifePremiumForAmount(1_000_000)).toBe(4_500)
  })
})
