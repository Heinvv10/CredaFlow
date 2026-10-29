import { describe, expect, it } from "vitest"
import { oidcMfaProven, samlMfaProven } from "./mfa"

describe("oidcMfaProven", () => {
  it("accepts the mfa method", () => expect(oidcMfaProven({ amr: ["pwd", "mfa"] }, [])).toBe(true))
  it("accepts two different factor types", () => expect(oidcMfaProven({ amr: ["pwd", "otp"] }, [])).toBe(true))
  it("accepts a possession plus an inherence factor", () => expect(oidcMfaProven({ amr: ["hwk", "fpt"] }, [])).toBe(true))
  it("refuses a password alone", () => expect(oidcMfaProven({ amr: ["pwd"] }, [])).toBe(false))
  it("refuses two factors of the same type", () => expect(oidcMfaProven({ amr: ["pwd", "pin"] }, [])).toBe(false))
  it("refuses a missing amr", () => expect(oidcMfaProven({}, [])).toBe(false))
  it("refuses an amr that is not an array of strings", () => {
    expect(oidcMfaProven({ amr: "mfa" }, [])).toBe(false)
    expect(oidcMfaProven({ amr: [1, 2] }, [])).toBe(false)
  })
  it("accepts an acr the lender named as MFA", () => expect(oidcMfaProven({ acr: "urn:bank:mfa" }, ["urn:bank:mfa"])).toBe(true))
  it("refuses an acr the lender did not name", () => expect(oidcMfaProven({ acr: "urn:bank:basic" }, ["urn:bank:mfa"])).toBe(false))
  it("ignores unknown amr values", () => expect(oidcMfaProven({ amr: ["pwd", "zzz"] }, [])).toBe(false))
})

describe("samlMfaProven", () => {
  it("accepts a built-in MFA context class", () => {
    expect(samlMfaProven("urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract", [])).toBe(true)
  })
  it("accepts a context the lender named", () => expect(samlMfaProven("urn:bank:mfa", ["urn:bank:mfa"])).toBe(true))
  it("refuses password-protected transport", () => {
    expect(samlMfaProven("urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport", [])).toBe(false)
  })
  it("refuses a missing context", () => expect(samlMfaProven(undefined, ["urn:bank:mfa"])).toBe(false))
})
