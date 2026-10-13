import { describe, expect, it } from "vitest"
import {
  evaluateCollectionsEligibility,
  isCollectionsEligible,
  isSection129Eligible,
  SECTION129_NON_NCA_REASON,
} from "./section129-eligibility"

// Section 129 is an NCA remedy (asset finance slice 1, item 4.2): a NON_NCA
// agreement is never eligible for it, however far in arrears; dunning is
// contractual and applies to both regimes.

const deepArrears = {
  status: "DEFAULTED",
  arrearsAmount: 250_000,
  outstandingPrincipal: 1_000_000,
  daysInArrears: 120,
}

describe("collections eligibility by NCA regime", () => {
  it("refuses Section 129 on a NON_NCA agreement at 120 DPD, with the regime as the reason", () => {
    expect(evaluateCollectionsEligibility({ ...deepArrears, ncaRegime: "NON_NCA" }, "SECTION_129")).toEqual({
      eligible: false,
      minimumDaysInArrears: 90,
      reason: SECTION129_NON_NCA_REASON,
    })
    expect(SECTION129_NON_NCA_REASON).toBe(
      "Section 129 applies to NCA credit agreements only; this agreement is not regulated by the NCA",
    )
    expect(isSection129Eligible({ ...deepArrears, ncaRegime: "NON_NCA" })).toBe(false)
  })

  it("still allows Section 129 on an NCA agreement at 90 DPD", () => {
    expect(isSection129Eligible({ ...deepArrears, daysInArrears: 90, ncaRegime: "NCA" })).toBe(true)
  })

  it("keeps dunning available on a NON_NCA agreement", () => {
    expect(evaluateCollectionsEligibility({ ...deepArrears, ncaRegime: "NON_NCA" }, "DUNNING")).toEqual({
      eligible: true,
      minimumDaysInArrears: 1,
      reason: null,
    })
    expect(isCollectionsEligible({ ...deepArrears, daysInArrears: 1, ncaRegime: "NON_NCA" })).toBe(true)
  })

  it("does not let the regime rescue an otherwise ineligible NON_NCA account for dunning", () => {
    expect(isCollectionsEligible({ ...deepArrears, status: "COMPLETED", ncaRegime: "NON_NCA" })).toBe(false)
  })
})
