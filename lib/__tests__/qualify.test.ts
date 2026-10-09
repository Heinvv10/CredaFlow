import { describe, it, expect } from "vitest"
import { computeQualification } from "../qualify"

describe("computeQualification", () => {
  // -------------------------------------------------------------------------
  // NDI and maxInstalment
  // -------------------------------------------------------------------------
  it("calculates NDI as income - expenses - existingDebt", () => {
    const result = computeQualification(1000000, 300000, 100000)
    expect(result.ndi).toBe(600000)
  })

  it("calculates maxInstalment as 70% of NDI (floor)", () => {
    const result = computeQualification(1000000, 300000, 100000)
    // NDI = 600000 → 70% = 420000
    expect(result.maxInstalment).toBe(420000)
  })

  it("returns zero maxInstalment when NDI is zero", () => {
    const result = computeQualification(500000, 500000, 0)
    expect(result.maxInstalment).toBe(0)
  })

  it("returns negative NDI when expenses exceed income", () => {
    const result = computeQualification(300000, 500000, 0)
    expect(result.ndi).toBe(-200000)
    expect(result.maxInstalment).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Zero qualification when no affordability
  // -------------------------------------------------------------------------
  it("returns zero amounts for all products when maxInstalment is 0", () => {
    const result = computeQualification(200000, 200000, 0)
    expect(result.microLoan.maxAmount).toBe(0)
    expect(result.personalLoan.maxAmount).toBe(0)
    expect(result.poFunding.maxAmount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Personal loan product
  // -------------------------------------------------------------------------
  it("qualifies a personal loan amount within affordability", () => {
    // NDI=3.5M, maxInstalment=2.45M — well above PMT for max R100K personal loan
    const result = computeQualification(4000000, 500000, 0)
    expect(result.personalLoan.maxAmount).toBeGreaterThan(0)
    expect(result.personalLoan.monthlyInstalment).toBeLessThanOrEqual(result.maxInstalment)
  })

  it("personal loan instalment is > 0 when maxAmount > 0", () => {
    const result = computeQualification(4000000, 500000, 0)
    if (result.personalLoan.maxAmount > 0) {
      expect(result.personalLoan.monthlyInstalment).toBeGreaterThan(0)
    }
  })

  // -------------------------------------------------------------------------
  // Micro loan product
  // -------------------------------------------------------------------------
  it("qualifies a micro loan amount within affordability", () => {
    const result = computeQualification(3000000, 1000000, 0)
    expect(result.microLoan.maxAmount).toBeGreaterThan(0)
    expect(result.microLoan.totalRepayable).toBeLessThanOrEqual(result.maxInstalment)
  })

  // -------------------------------------------------------------------------
  // PO funding product
  // -------------------------------------------------------------------------
  it("qualifies PO funding amount within affordability", () => {
    const result = computeQualification(10000000, 2000000, 0)
    expect(result.poFunding.maxAmount).toBeGreaterThan(0)
    expect(result.poFunding.monthlyInterest).toBeLessThanOrEqual(result.maxInstalment)
  })

  it("PO monthly interest equals 5% of maxAmount (prod POFUND rate)", () => {
    const result = computeQualification(10000000, 2000000, 0)
    expect(result.poFunding.maxAmount).toBeGreaterThan(0)
    expect(result.poFunding.monthlyInterest).toBe(Math.round(result.poFunding.maxAmount * 0.05))
  })

  // -------------------------------------------------------------------------
  // Qualification scales with income
  // Incomes chosen so that "low" does NOT hit the maxCents cap:
  //   low: NDI=400K, maxInstalment=280K — personal PMT for cap (R100K) ≈ 370K > 280K → capped below max
  //   high: NDI=3.5M, maxInstalment=2.45M — personal PMT for cap ≈ 370K << 2.45M → hits max
  // -------------------------------------------------------------------------
  it("higher income qualifies for larger loan amounts", () => {
    const low = computeQualification(900000, 500000, 0)
    const high = computeQualification(4000000, 500000, 0)
    expect(high.personalLoan.maxAmount).toBeGreaterThan(low.personalLoan.maxAmount)
    expect(high.poFunding.maxAmount).toBeGreaterThan(low.poFunding.maxAmount)
  })

  it("existing debt reduces qualification", () => {
    // clean: NDI=1.5M — qualifies for max R100K personal
    // indebted: add R12K debt → NDI=300K, maxInstalment=210K → personal PMT ≈ 370K > 210K → drops below max
    const clean = computeQualification(2000000, 500000, 0)
    const indebted = computeQualification(2000000, 500000, 1200000)
    expect(indebted.personalLoan.maxAmount).toBeLessThan(clean.personalLoan.maxAmount)
  })
})
