import { renderToStaticMarkup, renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { I18nProvider } from "@/lib/i18n/client"
import { applyLivePricing } from "@/lib/public-loan-products"
import { homeFaqs } from "@/app/(website)/site/home-faqs"
import { siteJurisdictionFor, ZA_SITE } from "@/lib/website/site-jurisdiction"
import Footer from "./Footer"
import { HomePage } from "./HomePage"
import NavBar from "./NavBar"
import { WebsiteIdentityProvider } from "./WebsiteIdentity"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

const KE = siteJurisdictionFor("KE")
const LENDER = { ...ACME_LENDER, fspNumber: "12345" }
const SOUTH_AFRICAN = /South Africa|POPIA|National Credit|\bNCA\b|\bNCR\b|FAIS|FSCA|FSP|Regulatory Information|regulatory-information/
const PRODUCTS = applyLivePricing({
  personal: {
    interestRatePm: 3, interestModel: "REDUCING_BALANCE", initiationFeePct: 0.15, initiationFeeMax: 605000,
    monthlyServiceFee: 6900, minAmount: 200000, maxAmount: 7500000, minTermDays: 90, maxTermDays: 1800,
  },
}).filter((p) => p.code === "personal")

describe("Footer", () => {
  it("for a South African lender links insurance, privacy and POPIA, the regulatory page and the NCR line", () => {
    const html = renderToStaticMarkup(<Footer identity={LENDER} site={ZA_SITE} />)
    expect(html).toContain('href="/site/products/insurance"')
    expect(html).toContain('href="/site/regulatory-information"')
    expect(html).toContain("Privacy &amp; POPIA")
    expect(html).toContain("Registered Credit Provider — NCR Reg: NCRCP99999 · FSP: 12345")
  })

  it("defaults to the South African footer when it is given no jurisdiction", () => {
    expect(renderToStaticMarkup(<Footer identity={LENDER} />)).toContain("NCR Reg: NCRCP99999")
  })

  it("for a Kenyan lender has no insurance link, regulatory page, POPIA label or NCR and FSP line", () => {
    const html = renderToStaticMarkup(<Footer identity={LENDER} site={KE} />)
    expect(html).not.toMatch(SOUTH_AFRICAN)
    expect(html).not.toContain("/site/products/insurance")
    expect(html).toContain('href="/site/privacy"')
    expect(html).toContain("Credit Provider")
    expect(html).toContain('href="/site/terms"')
  })
})

describe("NavBar insurance link", () => {
  const render = (site = ZA_SITE) => renderToString(
    <I18nProvider locale="en" messages={{}}>
      <WebsiteIdentityProvider identity={LENDER} jurisdiction={site}><NavBar /></WebsiteIdentityProvider>
    </I18nProvider>,
  )

  it("is there for a South African lender with an FSP number and absent for a Kenyan one that has one", () => {
    expect(render()).toContain('href="/site/products/insurance"')
    expect(render(KE)).not.toContain('href="/site/products/insurance"')
  })
})

describe("home page", () => {
  const home = (site = ZA_SITE) => renderToStaticMarkup(<HomePage identity={LENDER} products={PRODUCTS} site={site} />)

  it("for a South African lender keeps the NCR badge, the trust badges, the insurance card and the protections", () => {
    const html = home()
    expect(html).toContain("NCR-registered credit provider · NCRCP99999")
    expect(html).toContain("POPIA aligned")
    expect(html).toContain("FAIS authorised")
    expect(html).toContain('href="/site/products/insurance"')
    expect(html).toContain("How you&#x27;re protected")
    expect(html).toContain("Frequently asked questions")
  })

  it("for a Kenyan lender shows none of them", () => {
    const html = home(KE)
    expect(html).not.toMatch(/South Africa|POPIA|National Credit|\bNCA\b|NCR|FAIS|FSCA|FSP|insurance/i)
    expect(html).not.toContain('href="/site/products/insurance"')
    expect(html).not.toContain("How you&#x27;re protected")
    expect(html).not.toContain("Frequently asked questions")
    expect(html).toContain("Secure portal")
    expect(html).toContain("Personal loan")
  })

  it("has a FAQ for a South African lender and none for a Kenyan one", () => {
    expect(homeFaqs(LENDER, PRODUCTS).length).toBeGreaterThan(0)
    expect(homeFaqs(LENDER, PRODUCTS, "en", KE)).toEqual([])
  })
})
