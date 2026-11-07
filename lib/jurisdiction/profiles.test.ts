import { describe, expect, it } from "vitest"
import { CURRENCIES, currencyAllowed, JURISDICTIONS, KENYA_COUNTIES, parseCurrency, parseJurisdiction, profileFor } from "./profiles"

describe("jurisdiction profiles", () => {
  it("ZA keeps the NCA regime, the rand and SAST", () => {
    const za = profileFor("ZA")
    expect(za).toMatchObject({ code: "ZA", countryName: "South Africa", ncaRegulated: true, defaultCurrency: "ZAR", timeZone: "Africa/Johannesburg" })
  })

  it("LS is outside the NCA, in loti and on Maseru time", () => {
    const ls = profileFor("LS")
    expect(ls).toMatchObject({ code: "LS", countryName: "Lesotho", ncaRegulated: false, defaultCurrency: "LSL", timeZone: "Africa/Maseru" })
  })

  it("Maseru and Johannesburg share one UTC offset all year, so CAT is SAST for every date calculation", () => {
    const offset = (zone: string, at: Date) =>
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).format(at)
    for (let month = 0; month < 12; month++) {
      const at = new Date(Date.UTC(2026, month, 15, 12))
      expect(offset("Africa/Maseru", at)).toBe(offset("Africa/Johannesburg", at))
    }
  })

  it("parses a stored code and refuses anything else", () => {
    expect(JURISDICTIONS).toEqual(["ZA", "LS", "KE"])
    expect(CURRENCIES).toEqual(["ZAR", "LSL", "KES"])
    expect(parseJurisdiction("KE")).toBe("KE")
    expect(parseCurrency("KES")).toBe("KES")
    expect(parseJurisdiction("LS")).toBe("LS")
    expect(parseJurisdiction("ZA")).toBe("ZA")
    expect(() => parseJurisdiction("US")).toThrow(/jurisdiction/i)
    expect(() => parseJurisdiction(undefined)).toThrow(/jurisdiction/i)
  })
})

describe("Kenya", () => {
  it("is outside the NCA, in shillings and on Nairobi time", () => {
    expect(profileFor("KE")).toMatchObject({
      code: "KE", countryName: "Kenya", ncaRegulated: false, defaultCurrency: "KES", timeZone: "Africa/Nairobi", timeZoneLabel: "EAT",
    })
  })

  it("captures a numeric ID of up to 9 digits that encodes no date of birth, +254 mobiles, a county and a 5-digit postcode", () => {
    const c = profileFor("KE").capture
    expect(c).toMatchObject({ idScheme: "KE_ID", idEncodesDob: false, idAlphanumeric: false, idMaxLength: 9, mobileAllowSpaces: true, regionLabel: "County", postalDigits: 5, dialCode: "254" })
    const mobile = (v: string) => c.mobilePatterns.some((p) => p.test(v))
    for (const ok of ["+254712345678", "0712345678", "+254110123456", "0101234567"]) expect(mobile(ok), ok).toBe(true)
    for (const bad of ["+254212345678", "0212345678", "0821234567", "+27821234567", "071234567", "+2547123456789"]) expect(mobile(bad), bad).toBe(false)
  })

  it("lists the 47 counties with their official codes, 001 Mombasa to 047 Nairobi City", () => {
    expect(KENYA_COUNTIES).toHaveLength(47)
    expect(KENYA_COUNTIES.map((c) => c.code)).toEqual(Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(3, "0")))
    expect(KENYA_COUNTIES[0]).toEqual({ code: "001", label: "Mombasa" })
    expect(KENYA_COUNTIES[21]).toEqual({ code: "022", label: "Kiambu" })
    expect(KENYA_COUNTIES[46]).toEqual({ code: "047", label: "Nairobi City" })
    expect(new Set(KENYA_COUNTIES.map((c) => c.label)).size).toBe(47)
  })

  it("each jurisdiction has its own dial code; a local 0 number takes it, except in Lesotho (no trunk prefix), where it is South African", () => {
    expect(JURISDICTIONS.map((j) => profileFor(j).capture.dialCode)).toEqual(["27", "266", "254"])
    expect(JURISDICTIONS.map((j) => profileFor(j).capture.localZeroDialCode)).toEqual(["27", "27", "254"])
  })

  // KNOWN GAP (docs: plan trap 5). The date code is pinned to SAST (UTC+2); Nairobi is UTC+3 all year,
  // so between 00:00 and 01:00 EAT the system's date is still yesterday. Not fixed for the demo.
  it("KNOWN GAP: Nairobi is UTC+3 while the SAST-pinned date code is UTC+2", () => {
    const offset = (zone: string, at: Date) =>
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).format(at)
    for (let month = 0; month < 12; month++) {
      const at = new Date(Date.UTC(2026, month, 15, 12))
      expect(offset("Africa/Nairobi", at)).toContain("GMT+03:00")
      expect(offset("Africa/Johannesburg", at)).toContain("GMT+02:00")
    }
  })
})

describe("currencyAllowed", () => {
  it("ZA is rand only, LS loti or rand, KE shillings only", () => {
    expect(profileFor("ZA").allowedCurrencies).toEqual(["ZAR"])
    expect(profileFor("LS").allowedCurrencies).toEqual(["LSL", "ZAR"])
    expect(profileFor("KE").allowedCurrencies).toEqual(["KES"])
    const table = JURISDICTIONS.flatMap((j) => CURRENCIES.filter((c) => currencyAllowed(j, c)).map((c) => `${j}/${c}`))
    expect(table).toEqual(["ZA/ZAR", "LS/ZAR", "LS/LSL", "KE/KES"])
  })

  it("every profile's default currency is one it allows", () => {
    for (const j of JURISDICTIONS) expect(currencyAllowed(j, profileFor(j).defaultCurrency), j).toBe(true)
  })
})
