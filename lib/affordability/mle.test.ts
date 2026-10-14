import { describe, expect, it } from "vitest"
import { MLE_FORMULA_VERSION, minimumLivingExpense } from "./mle"

describe("minimumLivingExpense (NCA Reg 23A, 2015)", () => {
  it("exposes the formula version constant", () => {
    expect(MLE_FORMULA_VERSION).toBe("2015-NCA-Reg-23A-r2")
  })

  it("returns 0 cents at R0 gross income", () => {
    expect(minimumLivingExpense(0)).toBe(0)
  })

  it("never returns a negative minimum", () => {
    expect(minimumLivingExpense(-100_00)).toBe(0)
  })

  it("counts 100% of gross income up to R800", () => {
    expect(minimumLivingExpense(500_00)).toBe(500_00)
  })

  it("returns R800 at the R800 boundary", () => {
    // 100% of R800 — continuous with the next bracket's R800 fixed amount
    expect(minimumLivingExpense(800_00)).toBe(800_00)
  })

  it("rounds the 6.75% bracket at R800.01 to R800.00", () => {
    // 6.75% of 1 cent = 0.0675 → Math.round → 0; baseline R800 = R800.00
    expect(minimumLivingExpense(800_01)).toBe(800_00)
  })

  it("computes R1,167.88 at the R6,250 boundary", () => {
    // R800 + 6.75% × (R6,250 - R800) = 800 + 367.875 = R1,167.875 → R1,167.88
    expect(minimumLivingExpense(6_250_00)).toBe(1_167_88)
  })

  it("enters the 9% bracket at R6,250.01", () => {
    expect(minimumLivingExpense(6_250_01)).toBe(1_167_88)
  })

  it("uses the 9% bracket above R6,250", () => {
    // R1,167.88 + 9% × (R10,000 - R6,250) = 1167.88 + 337.50 = R1,505.38
    expect(minimumLivingExpense(10_000_00)).toBe(1_505_38)
  })

  it("computes R2,855.38 at the R25,000 boundary", () => {
    // R1,167.88 + 9% × (R25,000 - R6,250) = 1167.88 + 1687.50 = R2,855.38
    expect(minimumLivingExpense(25_000_00)).toBe(2_855_38)
  })

  it("enters the 8.2% bracket at R25,000.01", () => {
    expect(minimumLivingExpense(25_000_01)).toBe(2_855_38)
  })

  it("uses the 8.2% bracket above R25,000", () => {
    // R2,855.38 + 8.2% × (R40,000 - R25,000) = 2855.38 + 1230.00 = R4,085.38
    expect(minimumLivingExpense(40_000_00)).toBe(4_085_38)
  })

  it("computes R4,905.38 at the R50,000 boundary", () => {
    // R2,855.38 + 8.2% × (R50,000 - R25,000) = 2855.38 + 2050.00 = R4,905.38
    expect(minimumLivingExpense(50_000_00)).toBe(4_905_38)
  })

  it("enters the 6.75% bracket at R50,000.01", () => {
    expect(minimumLivingExpense(50_000_01)).toBe(4_905_38)
  })

  it("uses the 6.75% bracket above R50,000", () => {
    // R4,905.38 + 6.75% × (R60,000 - R50,000) = 4905.38 + 675.00 = R5,580.38
    expect(minimumLivingExpense(60_000_00)).toBe(5_580_38)
  })
})
