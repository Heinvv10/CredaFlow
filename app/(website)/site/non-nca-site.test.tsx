import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import type { Currency, Jurisdiction } from "@/lib/jurisdiction/profiles"
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
import ContactLayout, { generateMetadata as contactMetadata } from "./contact/layout"
import QualifyPage from "./qualify/page"
import QualifyLayout, { generateMetadata as qualifyMetadata } from "./qualify/layout"
import { publicLoanProducts } from "@/lib/public-loan-products"
import { buildKnowledge } from "@/lib/website-chat/knowledge"

/** Every South African statute, regulator and registration the public site names. */
const SOUTH_AFRICAN = /South Africa|POPIA|National Credit|\bNCA\b|\bNCR\b|FAIS|FSCA|FICA|Information Regulator|inforegulator|SA ID|Republic of/
const NO_REGULATOR = new RegExp(`${SOUTH_AFRICAN.source}|Ombud|Tribunal|insurance|Insurance`)

const lenderWithFsp = { ...ACME_LENDER, ncrNumber: "NCRCP99999", fspNumber: "12345" }

const CASES: ReadonlyArray<{ code: Jurisdiction; currency: Currency; country: string; idLabel: string; idMax: number }> = [
  { code: "KE", currency: "KES", country: "Kenya", idLabel: "National ID number", idMax: 9 },
  { code: "LS", currency: "LSL", country: "Lesotho", idLabel: "National ID number", idMax: 15 },
]

const render = async (Page: () => Promise<React.ReactElement | null>) => {
  const element = await Page()
  return element ? renderToStaticMarkup(element) : ""
}
const inSite = (site: SiteJurisdiction, element: React.ReactNode) => renderToStaticMarkup(
  <WebsiteIdentityProvider identity={lenderWithFsp} jurisdiction={site}>{element}</WebsiteIdentityProvider>,
)

beforeEach(() => identityMock.mockResolvedValue(lenderWithFsp))
afterEach(() => resetActiveJurisdiction())

// A South African lender's site is pinned in ./za-pinned.test.tsx; these are the lenders outside the NCA.
describe.each(CASES)("the website of a $country lender", ({ code, currency, country, idLabel, idMax }) => {
  const site = siteJurisdictionFor(code)
  beforeEach(() => setActiveJurisdiction({ jurisdiction: code, currency }))

  it("terms: governed by the laws of the country, no South African law, regulator or product, six numbered sections", async () => {
    const html = await render(TermsPage)
    expect(html).toContain(`are governed by the laws of ${country}, and its courts have jurisdiction. Any credit product remains subject to the laws that apply to it.`)
    expect(html).not.toMatch(SOUTH_AFRICAN)
    expect(html).not.toMatch(/insurance|FSP|\/site\/regulatory-information/i)
    const numbers = [...html.matchAll(/<h2[^>]*>(\d+)\. /g)].map((m) => Number(m[1]))
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6])
    expect(String((await termsMetadata()).description)).not.toMatch(/insurance|credit agreement/)
  })

  it("privacy: the data-protection law that applies in the country, no South African one", async () => {
    const html = await render(PrivacyPage)
    expect(html).toContain(`data-protection law that applies in ${country}`)
    expect(html).toContain(`Complain to Acme Lending or the data-protection authority in ${country}.`)
    expect(html).toContain("Name, national ID number, date of birth")
    expect(html).not.toMatch(SOUTH_AFRICAN)
    expect(html).not.toMatch(/insurer|insurance|inforegulator|mailto:POPIA/i)
    const meta = await privacyMetadata()
    expect(meta.title).toBe("Privacy Policy | Acme Lending")
    expect(JSON.stringify(meta)).not.toMatch(SOUTH_AFRICAN)
  })

  it("regulatory information: not found in the page, the layout, and its metadata is empty", async () => {
    await expect(RegulatoryInformationPage()).rejects.toBeInstanceOf(NotFound)
    await expect(RegulatoryInformationLayout({ children: null })).rejects.toBeInstanceOf(NotFound)
    expect(await regulatoryMetadata()).toEqual({})
  })

  it("apply: the profile's ID label and length, no South African law, no FAQ", async () => {
    const html = inSite(site, <ApplyPage />)
    expect(html).toContain(`${idLabel} *`)
    expect(html).toContain(`maxLength="${idMax}"`)
    expect(html).not.toMatch(SOUTH_AFRICAN)
    expect(html).not.toContain("What to expect when you apply")
    expect(JSON.stringify(await applyMetadata())).not.toMatch(SOUTH_AFRICAN)
    expect(renderToStaticMarkup(await ApplyLayout({ children: <p>kid</p> }))).not.toContain("FAQPage")
  })

  it("calculators: no NCR disclosure, no rule box, no insurance or pre-agreement wording", async () => {
    const html = inSite(site, await CalculatorsPage() as React.ReactElement)
    expect(html).toContain("subject to a full credit and affordability assessment.")
    expect(html).not.toContain("Affordability Rule")
    expect(html).toContain("Are fees included in the estimate?")
    expect(html).not.toMatch(new RegExp(`${NO_REGULATOR.source}|pre-agreement|registered credit provider`))
    expect(String((await calculatorsMetadata()).description)).not.toMatch(SOUTH_AFRICAN)
  })

  it("qualify: the result disclaimer, the FAQ, the schema and the metadata name no South African law", async () => {
    const result = inSite(site, <QualifyResult incomeCents={2_000_000} expensesCents={500_000} amountRands={3000} termValue={3} products={publicLoanProducts} onRestart={() => {}} />)
    expect(result).toContain("Final approval is subject to a full credit and affordability assessment. Acme Lending (Pty) Ltd.")
    expect(result).not.toMatch(SOUTH_AFRICAN)
    const page = inSite(site, <QualifyPage />)
    expect(page).toContain("Approval is still subject to a full affordability assessment, document verification and disclosure of the loan terms.")
    expect(page).not.toMatch(NO_REGULATOR)
    const layout = renderToStaticMarkup(await QualifyLayout({ children: <p>kid</p> }))
    expect(layout).not.toMatch(NO_REGULATOR)
    expect(JSON.stringify(await qualifyMetadata())).not.toMatch(NO_REGULATOR)
  })

  it("contact: the complaint goes to the lender first, then the regulator or ombud that applies in the country", async () => {
    const html = inSite(site, <ContactPage />)
    expect(html).toContain(`If we have not resolved it, you may take it to the regulator or ombud that applies to your credit product in ${country}.`)
    expect(html).not.toMatch(NO_REGULATOR)
    const layout = renderToStaticMarkup(await ContactLayout({ children: <p>kid</p> }))
    expect(layout).toContain(`regulator or ombud that applies to your credit product in ${country}`)
    expect(layout).not.toMatch(NO_REGULATOR)
    expect(String((await contactMetadata()).description)).toBe("Contact us for product enquiries or to lodge a complaint. Office details, email and complaints process.")
  })

  it("chat knowledge: no NCA-only page, registration or insurance", () => {
    const text = buildKnowledge({ identity: { ...lenderWithFsp, ncrStatus: "Registered" }, products: [], insurance: [{ name: "Funeral plan", type: "FUNERAL_COVER" }], site })
    expect(text).not.toMatch(/regulatory-information|\/site\/products\/insurance|NCR|FSP|Funeral plan|Insurance/)
    expect(text).toContain("/site/privacy")
    expect(text).toContain("Acme Lending (Pty) Ltd. Company registration 2020/123456/07.")
  })
})
