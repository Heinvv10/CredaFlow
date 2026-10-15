import { describe, expect, it } from "vitest"
import { costTotals, recoveryOutcome } from "./recovery-outcome"

const figures = { settlementDueCents: 100_000, grossProceedsCents: 0, deductedCostsCents: 0, chargedCostsCents: 0 }

describe("recoveryOutcome", () => {
  it("shortfall: net proceeds below the settlement", () => {
    expect(recoveryOutcome({ ...figures, grossProceedsCents: 80_000, deductedCostsCents: 5_000 })).toEqual({
      netProceedsCents: 75_000, paymentCents: 75_000, shortfallCents: 25_000, surplusCents: 0,
    })
  })

  it("charged costs add to what is owed, not to the payment", () => {
    expect(recoveryOutcome({ ...figures, grossProceedsCents: 80_000, chargedCostsCents: 4_000 })).toEqual({
      netProceedsCents: 80_000, paymentCents: 80_000, shortfallCents: 24_000, surplusCents: 0,
    })
  })

  it("surplus: net proceeds above settlement plus charged costs; payment capped at the settlement", () => {
    expect(recoveryOutcome({ ...figures, grossProceedsCents: 130_000, deductedCostsCents: 10_000, chargedCostsCents: 5_000 })).toEqual({
      netProceedsCents: 120_000, paymentCents: 100_000, shortfallCents: 0, surplusCents: 15_000,
    })
  })

  it("exact settlement leaves neither shortfall nor surplus", () => {
    expect(recoveryOutcome({ ...figures, grossProceedsCents: 100_000 })).toEqual({
      netProceedsCents: 100_000, paymentCents: 100_000, shortfallCents: 0, surplusCents: 0,
    })
  })

  it("refuses deducted costs above the gross proceeds (net would be negative, breaking net = gross - deducted)", () => {
    expect(() => recoveryOutcome({ ...figures, grossProceedsCents: 3_000, deductedCostsCents: 5_000 })).toThrow(RangeError)
  })

  it("rejects non-integer or negative cents", () => {
    expect(() => recoveryOutcome({ ...figures, grossProceedsCents: 1.5 })).toThrow(RangeError)
    expect(() => recoveryOutcome({ ...figures, settlementDueCents: -1 })).toThrow(RangeError)
    expect(() => recoveryOutcome({ ...figures, deductedCostsCents: Number.NaN })).toThrow(RangeError)
    expect(() => recoveryOutcome({ ...figures, chargedCostsCents: -5 })).toThrow(RangeError)
  })
})

describe("costTotals", () => {
  it("sums gross cents by treatment", () => {
    expect(costTotals([
      { grossCents: 1_150, treatment: "DEDUCT_FROM_PROCEEDS" },
      { grossCents: 2_300, treatment: "CHARGE_TO_ACCOUNT" },
      { grossCents: 500, treatment: "DEDUCT_FROM_PROCEEDS" },
    ])).toEqual({ deducted: 1_650, charged: 2_300 })
  })

  it("is zero for no costs and rejects a bad amount", () => {
    expect(costTotals([])).toEqual({ deducted: 0, charged: 0 })
    expect(() => costTotals([{ grossCents: 0.5, treatment: "DEDUCT_FROM_PROCEEDS" }])).toThrow(RangeError)
  })
})
