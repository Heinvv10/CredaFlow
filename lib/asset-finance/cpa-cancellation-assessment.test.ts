import { describe, expect, it } from "vitest"
import { assessReasonableCancellation, CPA_CANCELLATION_FACTORS } from "./cpa-cancellation-assessment"

const assessment = () => ({
  assessedChargeCents: 500,
  factors: Object.fromEntries(CPA_CANCELLATION_FACTORS.map(([key]) => [key, "Synthetic case-specific evidence and assessment"])),
  rationale: "Alternative lessee already identified; reduce the financial loss ceiling",
  cancellationRightReason: "The reduced amount leaves cancellation economically available to this consumer",
})
describe("Regulation 5 reasonable cancellation assessment", () => {
  it("requires case-specific consideration before turning a formula ceiling into a charge", () => {
    expect(() => assessReasonableCancellation(undefined, 1000)).toThrow(/assessment/i)
    const missing = assessment()
    delete missing.factors.industryPractice
    expect(() => assessReasonableCancellation(missing, 1000)).toThrow(/factor/i)
  })
  it("permits a reasoned reduction and full waiver, never an amount exceeding the formula ceiling", () => {
    expect(assessReasonableCancellation(assessment(), 1000)).toMatchObject({ assessedChargeCents: 500, ceilingCents: 1000 })
    expect(assessReasonableCancellation({ ...assessment(), assessedChargeCents: 0 }, 1000).assessedChargeCents).toBe(0)
    expect(() => assessReasonableCancellation({ ...assessment(), assessedChargeCents: 1001 }, 1000)).toThrow(/ceiling/i)
  })
  it("requires the separate Reg5(3) justification and a valid exact amount", () => {
    expect(() => assessReasonableCancellation({ ...assessment(), cancellationRightReason: " " }, 1000)).toThrow(/cancel/i)
    expect(() => assessReasonableCancellation({ ...assessment(), assessedChargeCents: -1 }, 1000)).toThrow()
    expect(() => assessReasonableCancellation({ ...assessment(), assessedChargeCents: 0.1 }, 1000)).toThrow()
    expect(() => assessReasonableCancellation({ ...assessment(), rationale: "" }, 1000)).toThrow()
  })
})
