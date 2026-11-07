/**
 * A South African lender's public website, pinned byte for byte.
 *
 * Every entry is the sha256 of one page's rendered output (or one text) taken from the tree BEFORE the
 * website followed the lender's jurisdiction (the parent of that commit), so a change to any South African
 * wording, markup or number fails here. The only normalisation is React's generated ids (`_R_…_`), which
 * depend on tree position, not on what is printed.
 *
 * To re-pin after a deliberate South African wording change (legal sign-off first, CLAUDE.md "Compliance"):
 * run this file on the tree you are comparing against with PIN_OUT=<file>, which writes the hashes instead
 * of asserting them, then paste them into PINNED. Written to import nothing that tree lacks.
 */
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { renderToStaticMarkup, renderToString } from "react-dom/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { I18nProvider } from "@/lib/i18n/client"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { applyLivePricing, publicLoanProducts } from "@/lib/public-loan-products"

const { identityMock, lenderMock } = vi.hoisted(() => ({ identityMock: vi.fn(), lenderMock: vi.fn() }))
vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: () => identityMock() }))
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: async () => ({}) }))
vi.mock("@/lib/public-loan-products-server", () => ({ getTenantPublicProductsServer: async () => [] }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: async () => "t1" }))
vi.mock("@/lib/config/identity", async (importOriginal) => ({ ...(await importOriginal<object>()), findLenderIdentity: () => lenderMock() }))
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND") },
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}))

import PrivacyPage, { generateMetadata as privacyMeta } from "./privacy/page"
import TermsPage, { generateMetadata as termsMeta } from "./terms/page"
import RegulatoryPage from "./regulatory-information/page"
import RegulatoryLayout, { generateMetadata as regulatoryMeta } from "./regulatory-information/layout"
import ApplyPage from "./apply/page"
import ApplyLayout, { generateMetadata as applyMeta } from "./apply/layout"
import CalculatorsPage, { generateMetadata as calculatorsMeta } from "./calculators/page"
import ContactPage from "./contact/page"
import ContactLayout, { generateMetadata as contactMeta } from "./contact/layout"
import QualifyPage from "./qualify/page"
import QualifyLayout, { generateMetadata as qualifyMeta } from "./qualify/layout"
import QualifyResult from "./qualify/QualifyResult"
import QualifyStepTwo from "./qualify/QualifyStepTwo"
import { homeFaqs } from "./home-faqs"
import Footer from "@/components/website/Footer"
import { HomePage } from "@/components/website/HomePage"
import NavBar from "@/components/website/NavBar"
import { RegulatoryBand } from "@/components/website/RegulatoryBand"
import { generateMetadata as homeMeta } from "@/app/page"
import { generateMetadata as layoutMeta } from "@/app/(website)/layout"
import sitemap from "@/app/sitemap"
import robots from "@/app/robots"
import { GET as llms } from "@/app/llms.txt/route"
import { organizationLd, webSiteLd } from "@/lib/seo/jsonld"
import { buildKnowledge } from "@/lib/website-chat/knowledge"
import { systemRules } from "@/lib/website-chat/prompt"
import { validateChatStart } from "@/lib/website-chat/validate"
import { formatZAR } from "@/lib/loan-calculator"

const PINNED: Record<string, string> = {
  "acme/privacy": "e5f45d9b38898994",
  "acme/privacy-meta": "a989f8daec5d849e",
  "acme/terms": "da6f5e168db3c08d",
  "acme/terms-meta": "2a49a889cd11a739",
  "acme/regulatory": "91b0343cc985da12",
  "acme/regulatory-layout": "9fb9fe86e197a796",
  "acme/regulatory-meta": "6e5ca0fb970427e1",
  "acme/apply": "3ddad8c76c7f9d1d",
  "acme/apply-layout": "9cef1b984eba41f6",
  "acme/apply-meta": "beb10f744822db69",
  "acme/calculators": "974244527efaeb75",
  "acme/calculators-meta": "da18e9c3cd2a3cbc",
  "acme/contact": "0da70b98ce7d99c5",
  "acme/contact-layout": "1d3d79d403df1c08",
  "acme/contact-meta": "684cbc22d7a7663b",
  "acme/qualify": "bf548f68dc6e50ed",
  "acme/qualify-layout": "d6de6f6b62976cc9",
  "acme/qualify-meta": "946ba2d712a09b0f",
  "acme/qualify-result": "519901c058178240",
  "acme/qualify-step-two": "a80b0f17c86888e4",
  "acme/footer": "ea50d07b5634c560",
  "acme/band": "b8d47c167c1fea9b",
  "acme/home": "a56cdae50aea81d4",
  "acme/home-faqs": "37d1222eae5d317e",
  "acme/nav": "abe23a68ebd8babb",
  "acme/home-meta": "30c4f6fbdc290ac1",
  "acme/layout-meta": "5db46322f67ac556",
  "acme/sitemap": "850082e59ca0e755",
  "acme/robots": "efb76b4ed0f1360f",
  "acme/llms": "03a0d1bed4c54304",
  "acme/org-ld": "46f67d81cd1fdc30",
  "acme/knowledge": "cc596af9832fb116",
  "full/privacy": "e5f45d9b38898994",
  "full/privacy-meta": "a989f8daec5d849e",
  "full/terms": "da6f5e168db3c08d",
  "full/terms-meta": "2a49a889cd11a739",
  "full/regulatory": "809bb183702b2374",
  "full/regulatory-layout": "9fb9fe86e197a796",
  "full/regulatory-meta": "6e5ca0fb970427e1",
  "full/apply": "3ddad8c76c7f9d1d",
  "full/apply-layout": "9cef1b984eba41f6",
  "full/apply-meta": "beb10f744822db69",
  "full/calculators": "974244527efaeb75",
  "full/calculators-meta": "da18e9c3cd2a3cbc",
  "full/contact": "0da70b98ce7d99c5",
  "full/contact-layout": "1d3d79d403df1c08",
  "full/contact-meta": "684cbc22d7a7663b",
  "full/qualify": "bf548f68dc6e50ed",
  "full/qualify-layout": "d6de6f6b62976cc9",
  "full/qualify-meta": "946ba2d712a09b0f",
  "full/qualify-result": "519901c058178240",
  "full/qualify-step-two": "a80b0f17c86888e4",
  "full/footer": "ea50d07b5634c560",
  "full/band": "b8d47c167c1fea9b",
  "full/home": "d6e2725b451dbc27",
  "full/home-faqs": "eec0ae922a23958c",
  "full/nav": "abe23a68ebd8babb",
  "full/home-meta": "30c4f6fbdc290ac1",
  "full/layout-meta": "5db46322f67ac556",
  "full/sitemap": "850082e59ca0e755",
  "full/robots": "efb76b4ed0f1360f",
  "full/llms": "0ce67ad299af95c2",
  "full/org-ld": "46f67d81cd1fdc30",
  "full/knowledge": "c2310df28d74be11",
  "nofsp/privacy": "e5f45d9b38898994",
  "nofsp/privacy-meta": "a989f8daec5d849e",
  "nofsp/terms": "995ebe1972a9f60e",
  "nofsp/terms-meta": "2a49a889cd11a739",
  "nofsp/regulatory": "1c753919769f24ff",
  "nofsp/regulatory-layout": "7b6f71936d9f7559",
  "nofsp/regulatory-meta": "52eee5867ba383ef",
  "nofsp/apply": "3ddad8c76c7f9d1d",
  "nofsp/apply-layout": "9cef1b984eba41f6",
  "nofsp/apply-meta": "f96a7c03ac7b7657",
  "nofsp/calculators": "974244527efaeb75",
  "nofsp/calculators-meta": "da18e9c3cd2a3cbc",
  "nofsp/contact": "0da70b98ce7d99c5",
  "nofsp/contact-layout": "1d3d79d403df1c08",
  "nofsp/contact-meta": "684cbc22d7a7663b",
  "nofsp/qualify": "bf548f68dc6e50ed",
  "nofsp/qualify-layout": "d6de6f6b62976cc9",
  "nofsp/qualify-meta": "946ba2d712a09b0f",
  "nofsp/qualify-result": "519901c058178240",
  "nofsp/qualify-step-two": "a80b0f17c86888e4",
  "nofsp/footer": "0a9f52ae7541c9ff",
  "nofsp/band": "f7a78ae1d45a7df7",
  "nofsp/home": "49513aee77059b4a",
  "nofsp/home-faqs": "71076ad27a157af8",
  "nofsp/nav": "bd5519800ca09720",
  "nofsp/home-meta": "30c4f6fbdc290ac1",
  "nofsp/layout-meta": "5db46322f67ac556",
  "nofsp/sitemap": "e776648dd03b24cc",
  "nofsp/robots": "efb76b4ed0f1360f",
  "nofsp/llms": "ecde2772539b1021",
  "nofsp/org-ld": "67e6ce886c95a643",
  "nofsp/knowledge": "e672df262ce61ae6",
  "chat-rules": "82eca9b96c5850ee",
  "chat-bad-phone": "2bb437030b26cf94",
  "format-zar": "d718c10853053385",
}

const REGULATORY = { ncrRegistrationDate: "2025-10-07", fscaAuthorisationDate: "2026-02-27", ncrStatus: "Registered" as const, headOfficeCity: "Sandton" }
const LENDERS = {
  acme: ACME_LENDER,
  full: { ...ACME_LENDER, ...REGULATORY },
  nofsp: { ...ACME_LENDER, ...REGULATORY, fspNumber: null },
}
const PERSONAL = applyLivePricing({
  personal: { interestRatePm: 3, interestModel: "REDUCING_BALANCE", initiationFeePct: 0.15, initiationFeeMax: 605000, monthlyServiceFee: 6900, minAmount: 200000, maxAmount: 7500000, minTermDays: 90, maxTermDays: 1800 },
}).filter((p) => p.code === "personal")

const sha = (text: string) => createHash("sha256").update(text.replace(/_R_[a-z0-9_]+_/g, "_R_")).digest("hex").slice(0, 16)
const computed: Record<string, string> = {}
function pin(name: string, value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  computed[name] = sha(text)
  if (!process.env.PIN_OUT) expect({ name, hash: computed[name] }).toEqual({ name, hash: PINNED[name] })
}
const html = (element: unknown) => renderToStaticMarkup(element as React.ReactElement)
const withIdentity = (identity: typeof ACME_LENDER, element: React.ReactNode) =>
  html(<WebsiteIdentityProvider identity={identity}>{element}</WebsiteIdentityProvider>)

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-07T10:00:00Z")) })
afterAll(() => {
  vi.useRealTimers()
  if (process.env.PIN_OUT) writeFileSync(process.env.PIN_OUT, JSON.stringify(computed, null, 2))
})
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "https://www.acme-lending.example"); lenderMock.mockResolvedValue(ACME_LENDER) })
afterEach(() => vi.unstubAllEnvs())

describe.each(Object.entries(LENDERS))("ZA website, lender %s", (key, lender) => {
  beforeEach(() => identityMock.mockResolvedValue(lender))

  it("legal pages and their metadata", async () => {
    pin(`${key}/privacy`, html(await PrivacyPage()))
    pin(`${key}/privacy-meta`, await privacyMeta())
    pin(`${key}/terms`, html(await TermsPage()))
    pin(`${key}/terms-meta`, await termsMeta())
    pin(`${key}/regulatory`, html(await RegulatoryPage()))
    pin(`${key}/regulatory-layout`, html(await RegulatoryLayout({ children: <p>x</p> })))
    pin(`${key}/regulatory-meta`, await regulatoryMeta())
  })

  it("product pages", async () => {
    pin(`${key}/apply`, withIdentity(lender, <ApplyPage />))
    pin(`${key}/apply-layout`, html(await ApplyLayout({ children: <p>x</p> })))
    pin(`${key}/apply-meta`, await applyMeta())
    pin(`${key}/calculators`, withIdentity(lender, await CalculatorsPage()))
    pin(`${key}/calculators-meta`, await calculatorsMeta())
    pin(`${key}/contact`, withIdentity(lender, <ContactPage />))
    pin(`${key}/contact-layout`, html(await ContactLayout({ children: <p>x</p> })))
    pin(`${key}/contact-meta`, await contactMeta())
    pin(`${key}/qualify`, withIdentity(lender, <QualifyPage />))
    pin(`${key}/qualify-layout`, html(await QualifyLayout({ children: <p>x</p> })))
    pin(`${key}/qualify-meta`, await qualifyMeta())
    pin(`${key}/qualify-result`, withIdentity(lender, <QualifyResult incomeCents={2_000_000} expensesCents={500_000} amountRands={3000} termValue={3} products={publicLoanProducts} onRestart={() => {}} />))
    pin(`${key}/qualify-step-two`, withIdentity(lender, <QualifyStepTwo data={{ amount: 5000, purpose: "", term: 7 }} onChange={() => {}} onNext={() => {}} onBack={() => {}} products={publicLoanProducts} />))
  })

  it("frame, home page, metadata and feeds", async () => {
    pin(`${key}/footer`, html(<Footer identity={lender} />))
    pin(`${key}/band`, html(<RegulatoryBand identity={lender} />))
    pin(`${key}/home`, html(<HomePage identity={lender} products={PERSONAL} />))
    pin(`${key}/home-faqs`, homeFaqs(lender, PERSONAL))
    pin(`${key}/nav`, renderToString(<I18nProvider locale="en" messages={{}}><WebsiteIdentityProvider identity={lender}><NavBar /></WebsiteIdentityProvider></I18nProvider>))
    pin(`${key}/home-meta`, await homeMeta())
    pin(`${key}/layout-meta`, await layoutMeta())
    pin(`${key}/sitemap`, (await sitemap()).map((e) => e.url))
    pin(`${key}/robots`, await robots())
    lenderMock.mockResolvedValue(lender)
    pin(`${key}/llms`, await (await llms()).text())
    pin(`${key}/org-ld`, [organizationLd(lender), webSiteLd(lender)])
    pin(`${key}/knowledge`, buildKnowledge({ identity: lender, products: PERSONAL, insurance: [{ name: "Funeral plan", type: "FUNERAL_COVER" }] }))
  })
})

describe("ZA texts that need no lender", () => {
  it("chat prompt, chat validation message and money format", () => {
    pin("chat-rules", systemRules("Acme Lending"))
    pin("chat-bad-phone", validateChatStart({ name: "Thandi Nkosi", phone: "12", email: "a@b.example", consent: true }))
    pin("format-zar", [formatZAR(0), formatZAR(123456), formatZAR(100000000), formatZAR(5)])
  })
})
