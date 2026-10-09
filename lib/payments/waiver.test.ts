import { describe, expect, it } from "vitest"
import { CASH_RECEIPTS, cashPaidPercent, cashReceivedCents, displayPaymentMethod, isBalanceWaiver } from "./waiver"

describe("balance waivers are not cash", () => {
  it("excludes the WAIVER method from any cash-collected query", () => {
    expect(CASH_RECEIPTS).toEqual({ paymentMethod: { not: "WAIVER" } })
  })

  it("labels a waiver as a waived balance and leaves every other method to the caller's format", () => {
    expect(isBalanceWaiver("WAIVER")).toBe(true)
    expect(isBalanceWaiver("EFT")).toBe(false)
    expect(displayPaymentMethod("WAIVER", (m) => m.toLowerCase())).toBe("Balance waived")
    expect(displayPaymentMethod("DEBIT_ORDER", (m) => m.toLowerCase().replace("_", " "))).toBe("debit order")
  })
})

describe("cashReceivedCents", () => {
  it("counts live allocated receipts only: no waivers, reversals, unapplied or refunded money", () => {
    expect(cashReceivedCents([
      { amount: 50_000, paymentMethod: "EFT", allocationStatus: "ALLOCATED", reversed: false },
      { amount: 75, paymentMethod: "WAIVER", allocationStatus: "ALLOCATED", reversed: false },
      { amount: 10_000, paymentMethod: "EFT", allocationStatus: "ALLOCATED", reversed: true },
      { amount: 5_000, paymentMethod: "EFT", allocationStatus: "UNAPPLIED", reversed: false },
      { amount: 2_000, paymentMethod: "CASH", allocationStatus: "REFUNDED", reversed: false },
      { amount: 1_000, paymentMethod: "CASH" },
    ])).toBe(51_000)
  })
})

describe("cashPaidPercent", () => {
  it("is cash received over total repayable, whole percent, capped at 100", () => {
    expect(cashPaidPercent(50_000, 216_900)).toBe(23)
    expect(cashPaidPercent(250_000, 216_900)).toBe(100)
    expect(cashPaidPercent(50_000, 0)).toBe(0)
  })
})
