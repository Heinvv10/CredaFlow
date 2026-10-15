import { describe, expect, it } from "vitest"
import { fundBalance, fundSettlement, needsSecondApprover } from "./maintenance-fund"

const m = (kind: "CONTRIBUTION" | "CLAIM" | "SETTLEMENT_REFUND" | "SETTLEMENT_BILLED", amountCents: number) => ({ kind, amountCents })

describe("fundBalance (C5)", () => {
  it("contributions in, paid claims out, a refund out, a billed deficit in", () => {
    expect(fundBalance([])).toBe(0)
    expect(fundBalance([m("CONTRIBUTION", 450_000), m("CONTRIBUTION", 450_000), m("CLAIM", 1_200_000)])).toBe(-300_000)
    expect(fundBalance([m("CONTRIBUTION", 900_000), m("CLAIM", 200_000), m("SETTLEMENT_REFUND", 700_000)])).toBe(0)
    expect(fundBalance([m("CONTRIBUTION", 100_000), m("CLAIM", 300_000), m("SETTLEMENT_BILLED", 200_000)])).toBe(0)
  })
})

describe("fundSettlement at the end of the term", () => {
  it("LENDER_RISK: the surplus or deficit is reported only", () => {
    expect(fundSettlement("LENDER_RISK", 250_000)).toEqual({ kind: "REPORTED", surplusCents: 250_000 })
    expect(fundSettlement("LENDER_RISK", -90_000)).toEqual({ kind: "REPORTED", surplusCents: -90_000 })
  })
  it("LESSEE_SETTLED: a surplus is refunded, a deficit billed, nothing when it is nil", () => {
    expect(fundSettlement("LESSEE_SETTLED", 250_000)).toEqual({ kind: "REFUND", amountCents: 250_000 })
    expect(fundSettlement("LESSEE_SETTLED", -90_000)).toEqual({ kind: "BILL", amountCents: 90_000 })
    expect(fundSettlement("LESSEE_SETTLED", 0)).toEqual({ kind: "NONE" })
  })
})

describe("needsSecondApprover", () => {
  it("at or above the tenant threshold", () => {
    expect(needsSecondApprover(4_999_999, 5_000_000)).toBe(false)
    expect(needsSecondApprover(5_000_000, 5_000_000)).toBe(true)
  })
})
