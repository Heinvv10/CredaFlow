import { describe, expect, it } from "vitest"
import { ncaRemittanceDisposition } from "./nca-surplus-disposition"
describe("surplus and the final notice issue together", () => {
  it("records a held-for-account exception without delaying the notice", () => {
    expect(ncaRemittanceDisposition(null)).toBe("HELD_NO_VERIFIED_ACCOUNT")
    expect(ncaRemittanceDisposition({ approvedById: null, releaseAuthorisedById: null })).toBe("HELD_NO_VERIFIED_ACCOUNT")
  })
  it("requires release clearance before a verified account can be remitted", () => {
    expect(() => ncaRemittanceDisposition({ approvedById: "second", releaseAuthorisedById: null })).toThrow(/release/i)
    expect(ncaRemittanceDisposition({ approvedById: "second", releaseAuthorisedById: "third" })).toBe("INSTRUCTED")
  })
})
