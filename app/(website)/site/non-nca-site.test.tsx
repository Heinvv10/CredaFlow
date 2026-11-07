import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { siteJurisdictionFor, type SiteJurisdiction } from "@/lib/website/site-jurisdiction"

class NotFound extends Error {}
const { identityMock } = vi.hoisted(() => ({ identityMock: vi.fn() }))
vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: () => identityMock() }))
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: async () => ({}) }))
vi.mock("next/navigation", () => ({
  notFound: () => { throw new NotFound("NEXT_NOT_FOUND") },
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/site/apply",
}))

import PrivacyPage, { generateMetadata as privacyMetadata } from "./privacy/page"
import TermsPage, { generateMetadata as termsMetadata } from "./terms/page"
import RegulatoryInformationPage from "./regulatory-information/page"
import RegulatoryInformationLayout, { generateMetadata as regulatoryMetadata } from "./regulatory-information/layout"
import ApplyPage from "./apply/page"
import ApplyLayout, { generateMetadata as applyMetadata } from "./apply/layout"
import CalculatorsPage, { generateMetadata as calculatorsMetadata } from "./calculators/page"
import QualifyResult from "./qualify/QualifyResult"
import ContactPage from "./contact/page"
import ContactLayout from "./contact/layout"
import QualifyPage from "./qualify/page"
import QualifyLayout, { generateMetadata as qualifyMetadata } from "./qualify/layout"
import { publicLoanProducts } from "@/lib/public-loan-products"
import { buildKnowledge } from "@/lib/website-chat/knowledge"

/** Every South African statute, regulator and registration the public site names. */
const SOUTH_AFRICAN = /South Africa|POPIA|National Credit|\bNCA\b|\bNCR\b|FAIS|FSCA|FICA|Information Regulator|inforegulator|SA ID|Republic of/

const KE: SiteJurisdiction = siteJurisdictionFor("KE")
const ke = () => setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
const lenderWithFsp = { ...ACME_LENDER, ncrNumber: "NCRCP99999", fspNumber: "12345" }

const render = async (Page: () => Promise<React.ReactElement | null>) => {
  const element = await Page()
  return element ? renderToStaticMarkup(element) : ""
}

beforeEach(() => identityMock.mockResolvedValue(lenderWithFsp))
afterEach(() => resetActiveJurisdiction())

describe("terms page", () => {
  it("for a South African lender keeps its governing law and NCA wording", async () => {
    const html = await render(TermsPage)
    expect(html).toContain("are governed by the laws of the Republic of South Africa, and the South African courts have jurisdiction. Any credit or insurance product remains subject to the laws that apply to it, including the National Credit Act and the Financial Advisory and Intermediary Services Act.")
    expect(html).toContain("as required by the National Credit Act (NCA) No. 34 of 2005")
    expect(html).toContain("Protection of Personal Information Act (POPIA)")
    expect(html).toContain("Insurance enquiries")
  })

  it("for a Kenyan lender names Kenya and no South African law, regulator or product", async () => {
    ke()
    const html = await render(TermsPage)
    expect(html).toContain("are governed by the laws of Kenya, and its courts have jurisdiction. Any credit product remains subject to the laws that apply to it.")
    expect(html).not.toMatch(SOUTH_AFRICAN)
    expect(html).not.toMatch(/insurance|FSP|\/site\/regulatory-information/i)
    const numbers = [...html.matchAll(/<h2[^>]*>(\d+)\. /g)].map((m) => Number(m[1]))
    expect(numbers).toEqual(numbers.map((_, i) => i + 1))
    expect(numbers.length).toBe(6)
  })

  it("for a Lesotho lender names Lesotho", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const html = await render(TermsPage)
    expect(html).toContain("governed by the laws of Lesotho")
    expect(html).not.toMatch(SOUTH_AFRICAN)
  })

  it("has a description with no South African law for a Kenyan lender, the original for a South African one", async () => {
    expect(String((await termsMetadata()).description)).toContain("any credit, insurance enquiry or capital service")
    ke()
    expect(String((await termsMetadata()).description)).not.toMatch(/insurance|credit agreement/)
  })
})

describe("privacy page", () => {
  it("for a South African lender keeps POPIA and the Information Regulator", async () => {
    const html = await render(PrivacyPage)
    expect(html).toContain("Complain to Acme Lending or the Information Regulator of South Africa.")
    expect(html).toContain("POPIAComplaints@inforegulator.org.za")
    expect(html).toContain("Name, South African ID number, date of birth")
    expect(html).toContain("NCR registration")
    const meta = await privacyMetadata()
    expect(meta.title).toBe("Privacy Policy & POPIA Notice | Acme Lending")
    expect(String(meta.description)).toContain("under POPIA")
  })

  it("for a Kenyan lender cites the data-protection law of Kenya and names no South African one", async () => {
    ke()
    const html = await render(PrivacyPage)
    expect(html).toContain("data-protection law that applies in Kenya")
    expect(html).toContain("Complain to Acme Lending or the data-protection authority in Kenya.")
    expect(html).toContain("National ID number".toLowerCase().replace("national id number", "national ID number"))
    expect(html).not.toMatch(SOUTH_AFRICAN)
    expect(html).not.toMatch(/insurer|insurance|inforegulator|mailto:POPIA/i)
    const meta = await privacyMetadata()
    expect(meta.title).toBe("Privacy Policy | Acme Lending")
    expect(JSON.stringify(meta)).not.toMatch(SOUTH_AFRICAN)
  })
})

describe("regulatory-information page", () => {
  it("is served to a South African lender", async () => {
    expect(await render(RegulatoryInformationPage)).toContain("NCR registration")
    expect(String((await regulatoryMetadata()).title)).toContain("NCR")
  })

  it("is not found for a Kenyan lender, in the page, the layout and its metadata", async () => {
    ke()
    await expect(RegulatoryInformationPage()).rejects.toBeInstanceOf(NotFound)
    await expect(RegulatoryInformationLayout({ children: null })).rejects.toBeInstanceOf(NotFound)
    expect(await regulatoryMetadata()).toEqual({})
  })
})

describe("apply page", () => {
  const apply = (site: SiteJurisdiction) => renderToStaticMarkup(
    <WebsiteIdentityProvider identity={lenderWithFsp} jurisdiction={site}><ApplyPage /></WebsiteIdentityProvider>,
  )

  it("for a South African lender keeps the SA ID field, the POPIA notice and the FAQ", () => {
    const html = apply(siteJurisdictionFor("ZA"))
    expect(html).toContain("SA ID Number *")
    expect(html).toContain('maxLength="13"')
    expect(html).toContain("POPIA consent, affordability assessment and credit checks are required before final approval.")
    expect(html).toContain("What to expect when you apply")
  })

  it("for a Kenyan lender asks for the national ID number and names no South African law", () => {
    ke()
    const html = apply(KE)
    expect(html).toContain("National ID number *")
    expect(html).toContain('maxLength="9"')
    expect(html).not.toMatch(SOUTH_AFRICAN)
    expect(html).not.toContain("What to expect when you apply")
  })

  it("has a description and structured data with no South African claim for a Kenyan lender", async () => {
    expect(String((await applyMetadata()).description)).toContain("POPIA-aware. Requires SA ID")
    ke()
    expect(JSON.stringify(await applyMetadata())).not.toMatch(SOUTH_AFRICAN)
    expect(renderToStaticMarkup(await ApplyLayout({ children: <p>kid</p> }))).not.toContain("FAQPage")
  })
})

describe("calculators page", () => {
  it("keeps the NCR disclosure for a South African lender and drops it for a Kenyan one", async () => {
    expect(await render(CalculatorsPage)).toContain("registered credit provider in terms of the National Credit Act (NCR Reg: NCRCP99999)")
    expect(String((await calculatorsMetadata()).description)).toContain("subject to NCA affordability assessment")
    ke()
    const html = await render(CalculatorsPage)
    expect(html).toContain("subject to a full credit and affordability assessment.")
    expect(html).not.toMatch(/registered credit provider|NCR Reg/)
    expect(String((await calculatorsMetadata()).description)).not.toMatch(SOUTH_AFRICAN)
  })
})

describe("qualify result disclaimer", () => {
  const result = (site: SiteJurisdiction) => renderToStaticMarkup(
    <WebsiteIdentityProvider identity={lenderWithFsp} jurisdiction={site}>
      <QualifyResult incomeCents={2_000_000} expensesCents={500_000} amountRands={3000} termValue={3} products={publicLoanProducts} onRestart={() => {}} />
    </WebsiteIdentityProvider>,
  )

  it("keeps the NCA wording for a South African lender", () => {
    expect(result(siteJurisdictionFor("ZA"))).toContain("as required by the National Credit Act (NCA) No. 34 of 2005.")
  })

  it("names no South African law for a Kenyan lender", () => {
    const html = result(KE)
    expect(html).toContain("Final approval is subject to a full credit and affordability assessment. Acme Lending (Pty) Ltd.")
    expect(html).not.toMatch(SOUTH_AFRICAN)
  })
})

const inSite = (site: SiteJurisdiction, element: React.ReactNode) => renderToStaticMarkup(
  <WebsiteIdentityProvider identity={lenderWithFsp} jurisdiction={site}>{element}</WebsiteIdentityProvider>,
)
const NO_REGULATOR = new RegExp(`${SOUTH_AFRICAN.source}|Ombud|Tribunal|insurance|Insurance`)

describe("contact page", () => {
  it("keeps the FAIS Ombud and POPIA answers for a South African lender", () => {
    const html = inSite(siteJurisdictionFor("ZA"), <ContactPage />)
    expect(html).toContain("you can take a credit complaint to the Credit Ombud or the National Credit Regulator (NCR)")
    expect(html).toContain("capture POPIA-compliant consent")
    expect(html).toContain("insurance enquiries or client portal support")
  })

  it("sends a Kenyan lender's complainant to the lender first, then the regulator or ombud that applies in Kenya", async () => {
    ke()
    const html = inSite(KE, <ContactPage />)
    expect(html).toContain("If we have not resolved it, you may take it to the regulator or ombud that applies to your credit product in Kenya.")
    expect(html).toContain("mark your enquiry as a complaint")
    expect(html).not.toMatch(NO_REGULATOR)
    const layout = renderToStaticMarkup(await ContactLayout({ children: <p>kid</p> }))
    expect(layout).toContain("regulator or ombud that applies to your credit product in Kenya")
    expect(layout).not.toMatch(NO_REGULATOR)
  })
})

describe("qualify page", () => {
  it("keeps the NCA wording for a South African lender", async () => {
    expect(inSite(siteJurisdictionFor("ZA"), <QualifyPage />)).toContain("full NCA affordability assessment, document verification")
    expect(String((await qualifyMetadata()).description)).toContain("full NCA affordability assessment")
  })

  it("says affordability assessment, with no NCA, to a Kenyan lender's visitor, in the page, the schema and the metadata", async () => {
    ke()
    const html = inSite(KE, <QualifyPage />)
    expect(html).toContain("Approval is still subject to a full affordability assessment, document verification and disclosure of the loan terms.")
    expect(html).not.toMatch(NO_REGULATOR)
    const layout = renderToStaticMarkup(await QualifyLayout({ children: <p>kid</p> }))
    expect(layout).toContain("a full affordability assessment")
    expect(layout).not.toMatch(NO_REGULATOR)
    expect(JSON.stringify(await qualifyMetadata())).not.toMatch(NO_REGULATOR)
  })
})

describe("calculators page rule box and answers", () => {
  it("keeps the NCA affordability rule and FAQ for a South African lender", async () => {
    const html = inSite(siteJurisdictionFor("ZA"), await CalculatorsPage() as React.ReactElement)
    expect(html).toContain("NCA Affordability Rule")
    expect(html).toContain("The National Credit Act requires that your loan instalment")
    expect(html).toContain("set during a full NCA affordability assessment")
    expect(html).toContain("Are fees or credit-life insurance included in the estimate?")
  })

  it("hides the rule box and keeps NCA, insurance and pre-agreement wording out of a Kenyan lender's page", async () => {
    ke()
    const html = inSite(KE, await CalculatorsPage() as React.ReactElement)
    expect(html).not.toContain("Affordability Rule")
    expect(html).toContain("set during a full affordability assessment")
    expect(html).toContain("Are fees included in the estimate?")
    expect(html).not.toMatch(new RegExp(`${NO_REGULATOR.source}|pre-agreement`))
  })
})

describe("website chat knowledge", () => {
  const input = { identity: { ...lenderWithFsp, ncrStatus: "Registered" as const }, products: [], insurance: [{ name: "Funeral plan", type: "FUNERAL_COVER" }] }

  it("for a South African lender links the regulatory page and states the registrations", () => {
    const text = buildKnowledge(input)
    expect(text).toContain("/site/regulatory-information")
    expect(text).toContain("NCR registration NCRCP99999")
    expect(text).toContain("Funeral plan")
  })

  it("for a Kenyan lender links no NCA-only page and states no NCR or FSP registration or insurance", () => {
    const text = buildKnowledge({ ...input, site: KE })
    expect(text).not.toMatch(/regulatory-information|\/site\/products\/insurance|NCR|FSP|Funeral plan|Insurance/)
    expect(text).toContain("/site/privacy")
    expect(text).toContain("Acme Lending (Pty) Ltd. Company registration 2020/123456/07.")
  })
})
