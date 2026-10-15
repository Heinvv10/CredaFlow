import { describe, expect, it } from "vitest"
import { CASH_THRESHOLD_CENTS, isReportableCash } from "./cash-threshold"

const cash = (amount: number, over: Partial<Parameters<typeof isReportableCash>[0]> = {}) =>
  isReportableCash({ paymentMethod: "CASH", amount, reversed: false, ...over })

describe("cash threshold boundary", () => {
  it("does not flag a cash receipt one cent under the threshold", () => {
    expect(cash(CASH_THRESHOLD_CENTS - 1)).toBe(false)
  })

  it("flags a cash receipt exactly at the threshold", () => {
    expect(cash(CASH_THRESHOLD_CENTS)).toBe(true)
  })

  it("flags a cash receipt over the threshold", () => {
    expect(cash(CASH_THRESHOLD_CENTS + 1)).toBe(true)
    expect(cash(CASH_THRESHOLD_CENTS * 3)).toBe(true)
  })

  it("never flags a non-cash method, whatever the amount", () => {
    for (const paymentMethod of ["EFT", "DEBIT_ORDER", "CARD", "WAIVER"] as const) {
      expect(cash(CASH_THRESHOLD_CENTS * 2, { paymentMethod }), paymentMethod).toBe(false)
    }
  })

  it("does not flag a reversed receipt", () => {
    expect(cash(CASH_THRESHOLD_CENTS * 2, { reversed: true })).toBe(false)
  })

  it("is a single constant in cents (the R49,999.99 belief, unverified)", () => {
    expect(CASH_THRESHOLD_CENTS).toBe(4_999_999)
  })
})
