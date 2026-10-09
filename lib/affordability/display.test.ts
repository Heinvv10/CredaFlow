import { describe, expect, it } from "vitest"
import { resolveAffordabilityDisplayInputs } from "./display"

const staleAssessment = {
  inputs: {
    monthlyIncomeCents: 1_500_000,
    monthlyExpensesCents: 800_000,
    proposedInstalmentCents: 250_000,
  },
}

describe("resolveAffordabilityDisplayInputs", () => {
  it("uses current client and calculator inputs while reassessment is editable", () => {
    expect(resolveAffordabilityDisplayInputs({
      locked: false,
      snapshot: staleAssessment,
      liveMonthlyIncomeCents: 1_700_000,
      liveMonthlyExpensesCents: 900_000,
      liveProposedInstalmentCents: 275_000,
    })).toEqual({
      monthlyIncomeCents: 1_700_000,
      monthlyExpensesCents: 900_000,
      proposedInstalmentCents: 275_000,
    })
  })

  it("uses immutable decision inputs after the application is locked", () => {
    expect(resolveAffordabilityDisplayInputs({
      locked: true,
      snapshot: staleAssessment,
      liveMonthlyIncomeCents: 1_700_000,
      liveMonthlyExpensesCents: 900_000,
      liveProposedInstalmentCents: 275_000,
    })).toEqual(staleAssessment.inputs)
  })

  it("fails closed when a locked application has no intact decision snapshot", () => {
    expect(resolveAffordabilityDisplayInputs({
      locked: true,
      snapshot: null,
      liveMonthlyIncomeCents: 1_700_000,
      liveMonthlyExpensesCents: 900_000,
      liveProposedInstalmentCents: 275_000,
    })).toEqual({
      monthlyIncomeCents: 0,
      monthlyExpensesCents: 0,
      proposedInstalmentCents: 0,
    })
  })
})
