import { describe, it, expect } from "vitest"
import { assessAffordability, affordabilityRiskGrade } from "./ndi"

describe("assessAffordability — all cents", () => {
  it("F-05 golden: Bongani R25k income, R8k expenses, R1,800 debt → NDI R15,200, AFFORDABLE", () => {
    // The audit bug treated the R1,800/m debt (180000 cents) as R180,000 and
    // produced NDI -R163,000 / NOT AFFORDABLE. Correct cents math:
    const r = assessAffordability({
      monthlyIncomeCents: 2_500_000,
      monthlyExpensesCents: 800_000,
      debts: [{ monthlyInstalment: 180_000 }], // R1,800/month
      proposedInstalmentCents: 200_000, // R2,000/month
    })
    expect(r.totalExistingDebt).toBe(180_000)
    expect(r.netDisposableIncome).toBe(1_520_000) // R15,200 — NOT -R163,000
    expect(r.ndiAfterLoan).toBe(1_320_000) // R13,200
    expect(r.isAffordable).toBe(true)
    expect(affordabilityRiskGrade(r)).toBe("A") // 13,200 >= 0.4 * 17,000 = 6,800
  })

  it("sums multiple debts and excludes negatives", () => {
    const r = assessAffordability({
      monthlyIncomeCents: 3_000_000,
      monthlyExpensesCents: 1_000_000,
      debts: [{ monthlyInstalment: 50_000 }, { monthlyInstalment: 70_000 }, { monthlyInstalment: -999 }],
      proposedInstalmentCents: 100_000,
    })
    expect(r.totalExistingDebt).toBe(120_000) // 50k + 70k, negative ignored
    expect(r.netDisposableIncome).toBe(1_880_000) // 2,000,000 - 120,000
    expect(r.ndiAfterLoan).toBe(1_780_000)
  })

  it("fails affordability when NDI after loan is negative", () => {
    const r = assessAffordability({
      monthlyIncomeCents: 1_000_000,
      monthlyExpensesCents: 700_000,
      debts: [{ monthlyInstalment: 150_000 }],
      proposedInstalmentCents: 200_000,
    })
    expect(r.netDisposableIncome).toBe(150_000)
    expect(r.ndiAfterLoan).toBe(-50_000)
    expect(r.isAffordable).toBe(false)
    expect(affordabilityRiskGrade(r)).toBe("D")
  })

  it("fails affordability when instalment ratio exceeds 0.7 even if NDI positive", () => {
    const r = assessAffordability({
      monthlyIncomeCents: 1_000_000,
      monthlyExpensesCents: 0,
      debts: [],
      proposedInstalmentCents: 800_000, // 0.8 of discretionary
    })
    expect(r.ndiAfterLoan).toBe(200_000) // positive
    expect(r.ratio).toBeCloseTo(0.8, 5)
    expect(r.isAffordable).toBe(false) // blocked by ratio gate
  })

  it("handles zero discretionary income without divide-by-zero", () => {
    const r = assessAffordability({
      monthlyIncomeCents: 500_000,
      monthlyExpensesCents: 500_000,
      debts: [],
      proposedInstalmentCents: 100_000,
    })
    expect(Number.isFinite(r.ratio)).toBe(true)
    expect(r.netDisposableIncome).toBe(0)
    expect(r.isAffordable).toBe(false)
  })
})
