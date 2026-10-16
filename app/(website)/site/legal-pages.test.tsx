import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"

const { identityMock } = vi.hoisted(() => ({ identityMock: vi.fn() }))
vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: () => identityMock() }))

import PrivacyPage from "./privacy/page"
import TermsPage from "./terms/page"
import RegulatoryInformationPage from "./regulatory-information/page"
import { generateMetadata as applyMetadata } from "./apply/layout"

const REGULATORY = { ncrRegistrationDate: "2025-10-07", fscaAuthorisationDate: "2026-02-27", ncrStatus: "Registered" as const, headOfficeCity: "Sandton" }
const render = async (Page: () => Promise<React.ReactElement | null>, identity: unknown = ACME_LENDER) => {
  identityMock.mockResolvedValue(identity)
  const element = await Page()
  return element ? renderToStaticMarkup(element) : ""
}

describe.each([
  ["privacy", PrivacyPage],
  ["terms", TermsPage],
  ["regulatory-information", RegulatoryInformationPage],
] as const)("%s page", (_name, Page) => {
  it("prints the tenant's own legal name and NCR number, and nothing of another lender", async () => {
    const html = await render(Page)
    expect(html).toContain("Acme Lending (Pty) Ltd")
    expect(html).toContain("NCRCP99999")
    expectNoOtherLender(html)
  })

  it("renders nothing when the identity is not configured (the layout shows the not-configured state)", async () => {
    expect(await render(Page, null)).toBe("")
  })
})

// §2a.2: no FSP number, no FSP or FAIS claim on the legal pages.
describe.each([
  ["terms", TermsPage],
  ["regulatory-information", RegulatoryInformationPage],
] as const)("%s page for a lender with no FSP number", (_name, Page) => {
  it("makes no FSP, FAIS or FSCA-authorisation claim", async () => {
    const html = await render(Page, { ...ACME_LENDER, ...REGULATORY, fspNumber: null })
    expect(html).toContain("NCRCP99999")
    // "FAIS Ombud" as a complaints route is not a claim; authorisation is.
    expect(html).not.toMatch(/\bFSP\b|FAIS[- ]authori|authorised financial services provider|FSCA authorisation/i)
  })
})

describe("privacy page", () => {
  it("names the tenant's own privacy contact", async () => {
    const html = await render(PrivacyPage)
    expect(html).toContain('href="mailto:hello@acme-lending.example"')
    expect(html).toContain("+27 11 000 0000")
    expect(html).toContain("Ask what personal information Acme Lending holds about you.")
  })
})

describe("terms page", () => {
  it("prints the tenant's FSP number and links only to pages that exist", async () => {
    const html = await render(TermsPage)
    expect(html).toContain("authorised intermediary (FSP 12345)")
    expect(html).not.toContain('href="/site/pricing"')
  })
})

describe("regulatory-information page", () => {
  it("leaves out each optional regulatory detail the tenant has not set", async () => {
    const html = await render(RegulatoryInformationPage)
    expect(html).not.toContain("NCR status")
    expect(html).not.toContain("NCR final registration date")
    expect(html).not.toContain("Final registration was confirmed")
    expect(html).not.toContain("FSCA authorisation date")
    expect(html).not.toContain("Authorisation was granted")
    expect(html).toContain("1 Main Road, Sandton, 2196")
  })

  it("prints the regulatory details when set", async () => {
    const html = await render(RegulatoryInformationPage, { ...ACME_LENDER, ...REGULATORY })
    expect(html).toContain("Registered")
    expect(html).toContain("7 October 2025")
    expect(html).toContain("27 February 2026")
  })

  it("shows WhatsApp only when the tenant has a WhatsApp number", async () => {
    expect(await render(RegulatoryInformationPage)).not.toContain("wa.me")
    const html = await render(RegulatoryInformationPage, { ...ACME_LENDER, publicWhatsapp: "+27 82 000 0000", publicWhatsappE164: "+27820000000" })
    expect(html).toContain("https://wa.me/27820000000")
  })
})

// #143 blind review: no new public factual claim for a lender with no FSP
// number ("does not offer insurance"); its insurance section is simply absent,
// and the apply page's description makes no FAIS claim.
describe("a lender with no FSP number", () => {
  const NO_FSP = { ...ACME_LENDER, ...REGULATORY, fspNumber: null }

  it("terms: no insurance section and no statement about insurance, the rest numbered in order", async () => {
    const html = await render(TermsPage, NO_FSP)
    expect(html).not.toMatch(/does not offer insurance|Insurance enquiries|insurance enquiry/)
    const headings = [...html.matchAll(/<h2[^>]*>(\d+)\. /g)].map((m) => Number(m[1]))
    expect(headings).toEqual(headings.map((_, i) => i + 1))
    expect(headings.length).toBeGreaterThan(4)
  })

  it("apply page description makes no FAIS claim", async () => {
    identityMock.mockResolvedValue(NO_FSP)
    expect(String((await applyMetadata()).description)).not.toMatch(/FAIS/)
    identityMock.mockResolvedValue(ACME_LENDER)
    expect(String((await applyMetadata()).description)).toContain("FAIS-authorised")
  })
})

// A demo lender's NCR and FSP numbers are fictional: say so beside them.
describe("regulatory page on a demo stack", () => {
  it("labels the registration numbers as a demo lender's, only when DEMO_MODE is on", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    try {
      expect(await render(RegulatoryInformationPage)).toContain("Demo lender: registration numbers are fictional.")
    } finally {
      vi.unstubAllEnvs()
    }
    expect(await render(RegulatoryInformationPage)).not.toContain("Demo lender")
  })
})
