import { describe, expect, it } from "vitest"
import { assessAssetFinanceAffordability } from "./affordability"

describe("asset-finance s81 affordability", () => {
  it("uses the lower of bank credits and AFS monthly turnover, then deducts debt service and the proposed instalment", () => {
    expect(assessAssetFinanceAffordability({
      borrower: "ENTITY",
      annualTurnoverCents: 12_000_000,
      averageMonthlyCreditsCents: 1_200_000,
      existingDebtServiceCents: 300_000,
      proposedInstalmentCents: 650_000,
      personalNdiCents: null,
    })).toEqual({
      verifiedBusinessIncomeCents: 1_000_000,
      businessNdiBeforeProposedCents: 700_000,
      personalNdiCents: null,
      combinedNdiAfterProposedCents: 50_000,
      affordable: true,
    })
  })

  it("combines a sole proprietor's consumer NDI and refuses a negative result", () => {
    expect(assessAssetFinanceAffordability({
      borrower: "SOLE_PROPRIETOR",
      annualTurnoverCents: 6_000_000,
      averageMonthlyCreditsCents: 450_000,
      existingDebtServiceCents: 300_000,
      proposedInstalmentCents: 400_001,
      personalNdiCents: 250_000,
    })).toMatchObject({ combinedNdiAfterProposedCents: -1, affordable: false })
  })

  it("requires the existing consumer NDI for a sole proprietor", () => {
    expect(() => assessAssetFinanceAffordability({
      borrower: "SOLE_PROPRIETOR",
      annualTurnoverCents: 1,
      averageMonthlyCreditsCents: 1,
      existingDebtServiceCents: 0,
      proposedInstalmentCents: 1,
      personalNdiCents: null,
    })).toThrow(/personal NDI/)
  })
})
