import { describe, expect, it } from "vitest"
import { CPA_CANCELLATION_FACTORS } from "./cpa-cancellation-assessment"
import { assessLessorCancellation } from "./lessor-cancellation-assessment"
const findings = (assessedChargeCents: number) => ({ assessedChargeCents, factors: Object.fromEntries(CPA_CANCELLATION_FACTORS.map(([key]) => [key, "Synthetic case-specific finding"])), rationale: "Reduce the demonstrated loss for an identified replacement lessee", fairnessReason: "A reduced charge avoids unfair disproportionate consequences of this breach" })
const inputs = { pvExclVatCents: 100_000, undiscountedRentalsCents: 150_000, netProceedsCents: 20_000, chargedCosts: [{ id: "cost-b", grossCents: 30_000 }, { id: "cost-a", grossCents: 10_000 }], vatRateTenThousandths: 1500 }
describe("CPA lessor cancellation: assessed net charge and noncash concessions", () => {
  it("refuses automatic financial-ceiling billing and incomplete findings", () => {
    expect(() => assessLessorCancellation(inputs, undefined)).toThrow(/assessment/i)
    expect(() => assessLessorCancellation(inputs, { ...findings(100), factors: {} })).toThrow(/factor/i)
    expect(() => assessLessorCancellation(inputs, { ...findings(100), fairnessReason: "" })).toThrow(/fair/i)
  })
  it("approves a lower NET amount, with one goods credit and explicit cost concession", () => {
    const result = assessLessorCancellation(inputs, findings(5000))
    expect(result).toMatchObject({ ceilingCents: 135_000, assessedChargeCents: 5000, damagesInclVatCents: 25_000, chargedCostsCents: 0, costConcessionCents: 40_000 })
    expect(result.costAllocations).toEqual([{ id: "cost-a", actualCents: 10_000, collectibleCents: 0 }, { id: "cost-b", actualCents: 30_000, collectibleCents: 0 }])
    expect(result.damagesInclVatCents + result.chargedCostsCents - inputs.netProceedsCents).toBe(5000)
  })
  it("records a partial original-cost-ID concession near the ceiling", () => {
    const result = assessLessorCancellation(inputs, findings(130_000))
    expect(result).toMatchObject({ damagesInclVatCents: 115_000, chargedCostsCents: 35_000, costConcessionCents: 5000 })
    expect(result.costAllocations).toEqual([{ id: "cost-a", actualCents: 10_000, collectibleCents: 10_000 }, { id: "cost-b", actualCents: 30_000, collectibleCents: 25_000 }])
  })
  it("allows full waiver even when actual costs exceed sale proceeds, without inventing cash", () => {
    expect(assessLessorCancellation(inputs, findings(0))).toMatchObject({ assessedChargeCents: 0, damagesInclVatCents: 20_000, chargedCostsCents: 0, costConcessionCents: 40_000 })
    expect(() => assessLessorCancellation(inputs, findings(135_001))).toThrow(/ceiling/i)
  })
  it("keeps exact cent VAT splits and reduced/ceiling net charges", () => {
    for (const pvExclVatCents of [1, 2, 3, 7, 11, 100_003]) for (const assessedChargeCents of [0, 1, 2]) {
      const input = { ...inputs, pvExclVatCents, netProceedsCents: 0, chargedCosts: [] }
      const ceiling = Math.min(pvExclVatCents + Math.round(pvExclVatCents * 0.15), input.undiscountedRentalsCents - 1)
      if (assessedChargeCents > ceiling) continue
      const result = assessLessorCancellation(input, findings(assessedChargeCents))
      expect(result.damagesInclVatCents).toBe(assessedChargeCents)
      expect(result.damagesExclVatCents).toBe(Math.round(assessedChargeCents / 1.15))
      expect(result.assessedChargeCents).toBe(Math.max(0, result.damagesInclVatCents + result.chargedCostsCents - input.netProceedsCents))
    }
    const ceiling = assessLessorCancellation(inputs, findings(135_000))
    expect(ceiling.damagesInclVatCents + ceiling.chargedCostsCents - inputs.netProceedsCents).toBe(135_000)
  })
  it("credits excess actual goods proceeds once and caps below undiscounted rentals", () => {
    expect(assessLessorCancellation({ ...inputs, netProceedsCents: 300_000 }, findings(0))).toMatchObject({ ceilingCents: 0, damagesInclVatCents: 115_000, costConcessionCents: 0 })
    const capped = assessLessorCancellation({ ...inputs, chargedCosts: [{ id: "cost", grossCents: 500_000 }] }, findings(0))
    expect(capped.ceilingCents).toBe(149_999)
    expect(capped.costConcessionCents).toBe(500_000)
  })
})
