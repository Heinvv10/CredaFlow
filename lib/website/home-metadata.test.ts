import { describe, expect, it } from "vitest"
import { siteJurisdictionFor } from "./site-jurisdiction"
import { homeDescription, homeTitle } from "./home-metadata"

const identity = { tradingName: "Acme Lending", ncrNumber: "NCRCP99999" }

describe("home page metadata", () => {
  it("keeps the South African title and description exactly", () => {
    const za = siteJurisdictionFor("ZA")
    expect(homeTitle(za)).toBe("Credit and insurance — South Africa")
    expect(homeDescription(identity, za)).toBe("Acme Lending offers responsible credit and insurance enquiries for South Africans. NCR-registered (NCRCP99999) with POPIA-aware processes.")
    expect(homeDescription({ ...identity, ncrNumber: null }, za)).toBe("Acme Lending offers responsible credit and insurance enquiries for South Africans. with POPIA-aware processes.")
  })

  it.each([["KE", "Kenya"], ["LS", "Lesotho"]] as const)("names %s's country, sells no insurance and cites no South African law", (code, country) => {
    const site = siteJurisdictionFor(code)
    expect(homeTitle(site)).toBe(`Credit — ${country}`)
    const description = homeDescription(identity, site)
    expect(description).toBe(`Acme Lending offers responsible credit for people in ${country}.`)
    expect(`${homeTitle(site)} ${description}`).not.toMatch(/South Africa|POPIA|NCR|insurance/i)
  })
})
