import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { validateLenderIdentityColumns } from "@/lib/config/identity-schema"
import { tenantColourErrors } from "@/lib/theme/tenant-colours"
import { resetActiveJurisdiction, setActiveJurisdiction } from "../lib/jurisdiction/active"
import { DEMO_LENDERS, demoLender, lenderJurisdiction } from "./demo-lender"

describe("demoLender", () => {
  it("defaults to Acme exactly as the seed hardcoded it before DEMO_LENDER existed", () => {
    // Literal on purpose: a change to the default lender must show up here.
    const acme = {
      slug: "acme",
      identity: {
        legalName: "Acme Lending (Pty) Ltd",
        brandName: "Acme Lending",
        ncrNumber: "NCRCP99999",
        fscaNumber: "12345",
        companyRegNumber: "2020/123456/07",
        registeredOffice: "1 Main Road\nSandton\n2196",
        publicEmail: "hello@acme-lending.example",
        publicPhone: "+27 11 000 0000",
        publicWhatsapp: null,
        collectionsEmail: "collections@acme-lending.example",
        collectionsPhone: "+27 11 000 0001",
        collectionsPhoneSecondary: null,
        brandTagline: null,
        ncrRegistrationDate: null,
        fscaAuthorisationDate: null,
        ncrStatus: null,
        headOfficeCity: null,
      },
      colours: { primaryColor: "#1F4E79", secondaryColor: "#245E92", darkColor: "#0F1115" },
      staffDomain: "acme-lending.example",
      clientDomain: "acme-lending.invalid",
      bureau: { supplierNumber: "ACME01", tradingName: "ACME LENDING" },
      requireSegregationOfDuties: false,
    }
    expect(demoLender({})).toEqual(acme)
    expect(demoLender({ DEMO_LENDER: "" })).toEqual(acme)
    expect(demoLender({ DEMO_LENDER: "acme" })).toEqual(acme)
  })

  it("selects the Fair Score profile: a fictional demo lender with fictional NCR and FSP numbers", () => {
    const fairscore = demoLender({ DEMO_LENDER: "fairscore" })
    expect(fairscore).toMatchObject({
      slug: "fairscore",
      identity: {
        legalName: "Fair Score Demo Lender (Pty) Ltd",
        brandName: "Fair Score",
        ncrNumber: "NCRCP98765",
        fscaNumber: "98765",
        companyRegNumber: "2099/000021/07",
        publicEmail: "hello@fairscore.example",
        collectionsEmail: "collections@fairscore.example",
        brandTagline: "Demo lender: fair credit, clearly scored",
      },
      colours: { primaryColor: "#033483", secondaryColor: "#0A63B8", darkColor: "#0F1A2E" },
      staffDomain: "fairscore.example",
      clientDomain: "fairscore.invalid",
      bureau: { supplierNumber: "FAIR01", tradingName: "FAIRSCORE" },
    })
    expect(JSON.stringify(fairscore).toLowerCase()).not.toContain("acme")
    // None of the Acme placeholders the audit found printed on its documents.
    for (const placeholder of ["NCRCP99999", "2020/123456/07", "1 Main Road", "+27 11 000 0000", "Fairscore"]) {
      expect(JSON.stringify(fairscore.identity)).not.toContain(placeholder)
    }
  })

  it("selects the Tsela profile, the marketing-site demo brand", () => {
    const tsela = demoLender({ DEMO_LENDER: "tsela" })
    expect(tsela).toMatchObject({
      slug: "tsela",
      identity: {
        legalName: "Tsela Lending (Pty) Ltd",
        brandName: "Tsela Lending",
        publicEmail: "hello@tsela-lending.example",
        collectionsEmail: "collections@tsela-lending.example",
      },
      staffDomain: "tsela-lending.example",
      clientDomain: "tsela-lending.invalid",
      bureau: { supplierNumber: "TSELA1", tradingName: "TSELA LENDING" },
    })
    expect(JSON.stringify(tsela).toLowerCase()).not.toContain("acme")
  })

  it.each(["nope", "toString", "__proto__", "ACME"])("refuses DEMO_LENDER=%s", (name) => {
    expect(() => demoLender({ DEMO_LENDER: name })).toThrow(/is not one of: acme, fairscore, tsela, basotho/)
  })

  describe.each(Object.entries(DEMO_LENDERS))("%s", (name, lender) => {
    it("mails borrowers only on a .invalid domain", () => {
      expect(lender.clientDomain).toMatch(/\.invalid$/)
      expect(lender.staffDomain).toMatch(/\.example$/)
      expect(lender.identity.publicEmail).toBe(`hello@${lender.staffDomain}`)
    })

    it("has an identity the audited identity API accepts and colours the tenant admin API accepts", () => {
      setActiveJurisdiction(lenderJurisdiction(lender))
      try {
        expect(validateLenderIdentityColumns(lender.identity)).toMatchObject({ ok: true })
      } finally {
        resetActiveJurisdiction()
      }
      expect(tenantColourErrors(lender.colours)).toEqual({})
    })

    it("turns segregation of duties off: one presenter approves and pays out", () => {
      expect(lender.requireSegregationOfDuties).toBe(false)
    })

    it("is keyed by its slug", () => {
      expect(lender.slug).toBe(name)
    })
  })

  it("selects the Lesotho profile: LS, loti, no NCR or FSP number, +266 phones", () => {
    const basotho = demoLender({ DEMO_LENDER: "basotho" })
    expect(lenderJurisdiction(basotho)).toEqual({ jurisdiction: "LS", currency: "LSL" })
    expect(basotho.identity).toMatchObject({ ncrNumber: null, fscaNumber: null, publicPhone: "+266 2200 0000" })
    expect(JSON.stringify(basotho).toLowerCase()).not.toContain("acme")
    expect(lenderJurisdiction(demoLender({}))).toEqual({ jurisdiction: "ZA", currency: "ZAR" })
  })

  it("prints one field for the shell scripts", () => {
    const run = (env: Record<string, string>) =>
      spawnSync("npx", ["tsx", "prisma/demo-lender.ts", "slug"], { env: { ...process.env, ...env }, encoding: "utf8" })
    expect(run({ DEMO_LENDER: "fairscore" }).stdout).toBe("fairscore\n")
    const bad = run({ DEMO_LENDER: "nope" })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/DEMO_LENDER=nope/)
  }, 30_000)
})
