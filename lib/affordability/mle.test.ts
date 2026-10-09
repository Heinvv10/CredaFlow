import { describe, expect, it } from "vitest"
import { MLE_FORMULA_VERSION, minimumLivingExpense } from "./mle"

describe("minimumLivingExpense (NCA Reg 23A, 2015)", () => {
  it("exposes the formula version constant", () => {
    expect(MLE_FORMULA_VERSION).toBe("2015-NCA-Reg-23A")
  })

  it("returns 0 cents at R0 gross income", () => {
    expect(minimumLivingExpense(0)).toBe(0)
  })

  it("returns 0 cents at the R800 boundary", () => {
    expect(minimumLivingExpense(800_00)).toBe(0)
  })

  it("rounds the 6.75% bracket at R800.01 to R800.00", () => {
    // 6.75% of 1 cent = 0.0675 → Math.round → 0; baseline R800 = R800.00
    expect(minimumLivingExpense(800_01)).toBe(800_00)
  })

  it("computes R1,167.88 at the R6,250 boundary", () => {
    // R800 + 6.75% × (R6,250 - R800) = 800 + 367.875 = R1,167.875 → R1,167.88
    expect(minimumLivingExpense(6_250_00)).toBe(1_167_88)
  })

  it("uses the 9% bracket above R6,250", () => {
    // R1,167.88 + 9% × (R10,000 - R6,250) = 1167.88 + 337.50 = R1,505.38
    expect(minimumLivingExpense(10_000_00)).toBe(1_505_38)
  })

  it("computes R2,855.38 at the R25,000 boundary", () => {
    // R1,167.88 + 9% × (R25,000 - R6,250) = 1167.88 + 1687.50 = R2,855.38
    expect(minimumLivingExpense(25_000_00)).toBe(2_855_38)
  })

  it("uses the 6.75% bracket above R25,000", () => {
    // R2,855.38 + 6.75% × (R50,000 - R25,000) = 2855.38 + 1687.50 = R4,542.88
    expect(minimumLivingExpense(50_000_00)).toBe(4_542_88)
  })
})
