import { describe, expect, it } from "vitest"
import { JURISDICTIONS, parseJurisdiction, profileFor } from "./profiles"

describe("jurisdiction profiles", () => {
  it("ZA keeps the NCA regime, the rand and SAST", () => {
    const za = profileFor("ZA")
    expect(za).toMatchObject({ code: "ZA", ncaRegulated: true, defaultCurrency: "ZAR", timeZone: "Africa/Johannesburg" })
  })

  it("LS is outside the NCA, in loti and on Maseru time", () => {
    const ls = profileFor("LS")
    expect(ls).toMatchObject({ code: "LS", ncaRegulated: false, defaultCurrency: "LSL", timeZone: "Africa/Maseru" })
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
    expect(JURISDICTIONS).toEqual(["ZA", "LS"])
    expect(parseJurisdiction("LS")).toBe("LS")
    expect(parseJurisdiction("ZA")).toBe("ZA")
    expect(() => parseJurisdiction("US")).toThrow(/jurisdiction/i)
    expect(() => parseJurisdiction(undefined)).toThrow(/jurisdiction/i)
  })
})
