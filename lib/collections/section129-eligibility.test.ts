import { describe, expect, it } from "vitest"
import {
  evaluateCollectionsEligibility,
  type CollectionsLoanState,
  isCollectionsEligible,
  isSection129Eligible,
} from "./section129-eligibility"

const baseLoan: CollectionsLoanState = {
  status: "DEFAULTED",
  ncaRegime: "NCA",
  arrearsAmount: 25_000,
  outstandingPrincipal: 100_000,
  daysInArrears: 90,
}

describe("collections eligibility policy", () => {
  it.each(["ACTIVE", "DEFAULTED"])(
    "allows an eligible %s loan at the Section 129 threshold",
    (status) => {
      expect(isSection129Eligible({ ...baseLoan, status })).toBe(true)
    },
  )

  it.each([0, 1, 89])("rejects a Section 129 notice at %i DPD", (daysInArrears) => {
    expect(isSection129Eligible({ ...baseLoan, daysInArrears })).toBe(false)
  })

  it("allows a Section 129 notice at exactly 90 DPD", () => {
    expect(isSection129Eligible({ ...baseLoan, daysInArrears: 90 })).toBe(true)
  })

  it.each([
    { status: "COMPLETED", arrearsAmount: 25_000, outstandingPrincipal: 100_000 },
    { status: "ACTIVE", arrearsAmount: 0, outstandingPrincipal: 100_000 },
    { status: "DEFAULTED", arrearsAmount: 25_000, outstandingPrincipal: 0 },
    { status: "CANCELLED", arrearsAmount: 25_000, outstandingPrincipal: 100_000 },
    { status: "WRITTEN_OFF", arrearsAmount: 25_000, outstandingPrincipal: 100_000 },
    { status: "RESTRUCTURED", arrearsAmount: 25_000, outstandingPrincipal: 100_000 },
    { status: "PENDING_WRITE_OFF", arrearsAmount: 25_000, outstandingPrincipal: 100_000 },
  ])("rejects an ineligible $status account", (overrides) => {
    expect(isSection129Eligible({ ...baseLoan, ...overrides })).toBe(false)
    expect(isCollectionsEligible({ ...baseLoan, ...overrides })).toBe(false)
  })

  it("uses a 1-DPD threshold for ordinary reminders/stages", () => {
    expect(isCollectionsEligible({ ...baseLoan, status: "ACTIVE", daysInArrears: 0 })).toBe(false)
    expect(isCollectionsEligible({ ...baseLoan, status: "ACTIVE", daysInArrears: 1 })).toBe(true)
  })

  it("returns an operator-facing threshold reason", () => {
    expect(
      evaluateCollectionsEligibility({ ...baseLoan, daysInArrears: 89 }, "SECTION_129"),
    ).toEqual({
      eligible: false,
      minimumDaysInArrears: 90,
      temporary: true,
      reason: "the account is below the 90-day arrears threshold",
    })
  })

  it("marks only time-curable blocks as temporary", () => {
    const t = (o: Partial<typeof baseLoan>) => evaluateCollectionsEligibility({ ...baseLoan, ...o }, "SECTION_129").temporary
    expect(t({ daysInArrears: 10 })).toBe(true)
    expect(t({ ncaRegime: "NON_NCA" })).toBe(false)
    expect(t({ status: "SETTLED" })).toBe(false)
    expect(t({ arrearsAmount: 0 })).toBe(false)
    expect(t({ outstandingPrincipal: 0 })).toBe(false)
    expect(evaluateCollectionsEligibility(baseLoan, "SECTION_129").temporary).toBe(false)
  })
})
