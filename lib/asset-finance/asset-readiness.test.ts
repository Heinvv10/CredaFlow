import { describe, expect, it } from "vitest"
import { assetReadinessPatch } from "./asset-readiness"

describe("assetReadinessPatch", () => {
  it("records late payout facts and clears blank optional values", () => {
    expect(assetReadinessPatch({
      natisTitleholder: " Test Lender ",
      trackerProvider: "Track Test",
      trackerId: " UNIT-1 ",
      insurer: "",
      policyNumber: "   ",
    }, true)).toEqual({
      natisTitleholder: "Test Lender",
      trackerProvider: "Track Test",
      trackerId: "UNIT-1",
      insurer: null,
      policyNumber: null,
      lenderNotedConfirmed: true,
    })
  })
})
