import { describe, expect, it } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { siteJurisdictionFor } from "@/lib/website/site-jurisdiction"
import { organizationLd, webSiteLd } from "./jsonld"

const lender = { ...ACME_LENDER, fspNumber: "12345" }

describe("organization structured data", () => {
  it("keeps the South African node: ZA address, NCR and FSP identifiers, en-ZA", () => {
    const org = organizationLd(lender)
    expect(org.address.addressCountry).toBe("ZA")
    expect(org.areaServed.name).toBe("South Africa")
    expect(org.description).toBe("Acme Lending (Pty) Ltd is a South African credit provider. Registered with the National Credit Regulator under NCRCP99999 and authorised by the Financial Sector Conduct Authority as a financial services provider under FSP number 12345.")
    expect(org.identifier.map((i) => i.propertyID)).toEqual(["NCR Registration", "FSP Licence", "CIPC Registration"])
    expect(org.contactPoint[0].availableLanguage).toEqual(["en-ZA"])
    expect(webSiteLd(lender).inLanguage).toBe("en-ZA")
  })

  it("for a Kenyan lender names Kenya and carries no South African registration or language", () => {
    const ke = siteJurisdictionFor("KE")
    const org = organizationLd(lender, ke)
    expect(org.address.addressCountry).toBe("KE")
    expect(org.areaServed.name).toBe("Kenya")
    expect(org.description).toBe("Acme Lending (Pty) Ltd is a credit provider in Kenya.")
    expect(org.identifier.map((i) => i.propertyID)).toEqual(["Company Registration"])
    expect(JSON.stringify([org, webSiteLd(lender, ke)])).not.toMatch(/South Africa|"ZA"|en-ZA|NCR|FSP|CIPC|National Credit/)
  })
})
