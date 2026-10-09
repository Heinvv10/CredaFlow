import { describe, it, expect } from "vitest"
import { buildExperianEnquiryInput, deriveDobFromSaId } from "@/lib/integrations/experian-input"

describe("deriveDobFromSaId", () => {
  it("derives YYYY-MM-DD from the ID's YYMMDD prefix (adult century)", () => {
    expect(deriveDobFromSaId("8806260001088")).toBe("1988-06-26")
  })
  it("returns null for an unparseable prefix", () => {
    expect(deriveDobFromSaId("9999997777087")).toBeNull()
  })
  it("returns null when neither century yields a plausible adult (ambiguous band)", () => {
    // yy=15,mm=03,dd=15 -> 1915 (too old) or 2015 (a minor as of the 2020s) -> null
    expect(deriveDobFromSaId("1503150000000")).toBeNull()
  })
})

describe("buildExperianEnquiryInput", () => {
  it("maps client fields, purpose=Affordability, consent Y, clientReference=applicationId", () => {
    const input = buildExperianEnquiryInput({
      idNumber: "8806260001088", firstName: "Nosipho", lastName: "Hypothetical",
      gender: "F", dateOfBirth: null, consentGranted: true, applicationId: "app_1",
    })
    expect(input.identityType).toBe("SID")
    expect(input.surname).toBe("Hypothetical")
    expect(input.forename).toBe("Nosipho")
    expect(input.purpose).toBe("11")
    expect(input.clientConsent).toBe("Y")
    expect(input.clientReference).toBe("app_1")
    expect(input.valueAdd?.bureauScore).toBe(true)
    expect(input.dateOfBirth).toBe("1988-06-26")  // derived (no client DOB)
    expect(input.gender).toBe("F")                // included when provided
  })
  it("omits gender entirely when it is null (not sent as null)", () => {
    const input = buildExperianEnquiryInput({
      idNumber: "8806260001088", firstName: "N", lastName: "H",
      gender: null, dateOfBirth: null, consentGranted: true, applicationId: "a",
    })
    expect("gender" in input).toBe(false)
  })
  it("prefers a client DOB whose YYMMDD matches the ID", () => {
    const input = buildExperianEnquiryInput({
      idNumber: "8806260001088", firstName: "N", lastName: "H",
      gender: null, dateOfBirth: new Date("1988-06-26T00:00:00Z"),
      consentGranted: true, applicationId: "a",
    })
    expect(input.dateOfBirth).toBe("1988-06-26")
  })
  it("falls back to derived DOB when the client DOB contradicts the ID prefix", () => {
    const input = buildExperianEnquiryInput({
      idNumber: "8806260001088", firstName: "N", lastName: "H",
      gender: null, dateOfBirth: new Date("1961-06-21T00:00:00Z"), // wrong prefix
      consentGranted: true, applicationId: "a",
    })
    expect(input.dateOfBirth).toBe("1988-06-26")
  })
  it("passes consent N through (Experian fails NS_208 closed)", () => {
    const input = buildExperianEnquiryInput({
      idNumber: "8806260001088", firstName: "N", lastName: "H",
      gender: "F", dateOfBirth: null, consentGranted: false, applicationId: "a",
    })
    expect(input.clientConsent).toBe("N")
  })
})
