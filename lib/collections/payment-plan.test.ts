import { describe, expect, it } from "vitest"
import { splitPaymentPlan } from "./payment-plan"

const sum = (total: number, n: number) => {
  const s = splitPaymentPlan(total, n)
  return s.regularCents * (n - 1) + s.finalCents
}

describe("splitPaymentPlan", () => {
  it("row 114: R2,058.34 over 3 is 2 x R686.11 + R686.12", () => {
    expect(splitPaymentPlan(205_834, 3)).toEqual({ regularCents: 68_611, finalCents: 68_612 })
  })
  it("an even split has equal instalments", () => {
    expect(splitPaymentPlan(300_000, 3)).toEqual({ regularCents: 100_000, finalCents: 100_000 })
  })
  it("sums exactly to the arrears for every total and instalment count", () => {
    for (const n of [1, 2, 3, 4, 6, 7, 12]) {
      for (let total = 1; total <= 2_000; total += 1) expect(sum(total, n)).toBe(total)
    }
  })
  it("a single instalment is the whole amount", () => {
    expect(splitPaymentPlan(12_345, 1)).toEqual({ regularCents: 12_345, finalCents: 12_345 })
  })
  it("rejects non-integer or non-positive input", () => {
    expect(() => splitPaymentPlan(100.5, 3)).toThrow(RangeError)
    expect(() => splitPaymentPlan(0, 3)).toThrow(RangeError)
    expect(() => splitPaymentPlan(100, 0)).toThrow(RangeError)
    expect(() => splitPaymentPlan(100, 2.5)).toThrow(RangeError)
  })
})
