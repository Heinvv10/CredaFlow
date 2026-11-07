import { describe, expect, it } from "vitest"
import { siteJurisdictionFor } from "@/lib/website/site-jurisdiction"
import { applyIdError } from "./id-check"

// A synthetic South African ID: 13 digits with a valid check digit.
const ZA_ID = "8001015009087"

describe("applyIdError", () => {
  it("keeps the South African check for a South African lender", () => {
    const za = siteJurisdictionFor("ZA")
    expect(applyIdError(za, ZA_ID, "bad SA ID")).toBeNull()
    expect(applyIdError(za, "8001015009088", "bad SA ID")).toBe("bad SA ID")
    expect(applyIdError(za, "12345678", "bad SA ID")).toBe("bad SA ID")
  })

  it("judges a Kenyan lender's ID by the Kenyan shape and says so in the Kenyan message", () => {
    const ke = siteJurisdictionFor("KE")
    expect(applyIdError(ke, "12345678", "bad SA ID")).toBeNull()
    expect(applyIdError(ke, " 123456789 ", "bad SA ID")).toBeNull()
    expect(applyIdError(ke, ZA_ID, "bad SA ID")).toBe("Not a valid Kenyan national ID number")
    expect(applyIdError(ke, "abc", "bad SA ID")).toBe("Not a valid Kenyan national ID number")
  })

  it("judges a Lesotho lender's ID by the Lesotho shape", () => {
    expect(applyIdError(siteJurisdictionFor("LS"), "!!", "bad SA ID")).toBe("Not a valid Lesotho national ID number")
  })
})
