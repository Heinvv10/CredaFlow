import { describe, it, expect } from "vitest"
import { computeCommissionCents, resolveEffectiveBps } from "./commission"

describe("computeCommissionCents", () => {
  it("computes principal × bps / 10000, rounded", () => {
    expect(computeCommissionCents(500_000, 200)).toBe(10_000) // R5000 @ 2% = R100
    expect(computeCommissionCents(333_333, 150)).toBe(5_000)  // rounds 4999.995 → 5000
  })
  it("returns 0 for non-positive rate or principal", () => {
    expect(computeCommissionCents(500_000, 0)).toBe(0)
    expect(computeCommissionCents(500_000, -5)).toBe(0)
    expect(computeCommissionCents(0, 200)).toBe(0)
    expect(computeCommissionCents(-100, 200)).toBe(0)
  })
})

describe("resolveEffectiveBps", () => {
  it("prefers the per-agent override", () => {
    expect(resolveEffectiveBps({ commissionBps: 300 }, { referralCommissionBps: 200 })).toBe(300)
  })
  it("falls back to the tenant default when no override", () => {
    expect(resolveEffectiveBps({ commissionBps: null }, { referralCommissionBps: 200 })).toBe(200)
  })
  it("is 0 when neither is set (commissions off)", () => {
    expect(resolveEffectiveBps({ commissionBps: null }, { referralCommissionBps: 0 })).toBe(0)
    expect(resolveEffectiveBps({ commissionBps: null }, null)).toBe(0)
  })
  it("treats an explicit 0 override as zero, not the tenant default", () => {
    expect(resolveEffectiveBps({ commissionBps: 0 }, { referralCommissionBps: 200 })).toBe(0)
  })
})
