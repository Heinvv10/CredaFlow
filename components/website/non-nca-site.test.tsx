import { renderToStaticMarkup, renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { I18nProvider } from "@/lib/i18n/client"
import { applyLivePricing } from "@/lib/public-loan-products"
import { homeFaqs } from "@/app/(website)/site/home-faqs"
import { siteJurisdictionFor } from "@/lib/website/site-jurisdiction"
import Footer from "./Footer"
import { HomePage } from "./HomePage"
import NavBar from "./NavBar"
import { WebsiteIdentityProvider } from "./WebsiteIdentity"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

const LENDER = { ...ACME_LENDER, fspNumber: "12345" }
const SOUTH_AFRICAN = /South Africa|POPIA|National Credit|\bNCA\b|\bNCR\b|FAIS|FSCA|FSP|Regulatory Information|regulatory-information/
const PRODUCTS = applyLivePricing({
  personal: {
    interestRatePm: 3, interestModel: "REDUCING_BALANCE", initiationFeePct: 0.15, initiationFeeMax: 605000,
    monthlyServiceFee: 6900, minAmount: 200000, maxAmount: 7500000, minTermDays: 90, maxTermDays: 1800,
  },
}).filter((p) => p.code === "personal")

// A South African lender's frame and home page are pinned in app/(website)/site/za-pinned.test.tsx.
describe.each([["KE"], ["LS"]] as const)("the frame and home page of a %s lender", (code) => {
  const site = siteJurisdictionFor(code)

  it("footer: no insurance link, regulatory page, POPIA label or NCR and FSP line", () => {
    const html = renderToStaticMarkup(<Footer identity={LENDER} site={site} />)
    expect(html).not.toMatch(SOUTH_AFRICAN)
    expect(html).not.toContain("/site/products/insurance")
    expect(html).toContain('href="/site/privacy"')
    expect(html).toContain('href="/site/terms"')
    expect(html).toContain("Credit Provider")
  })

  it("navigation: no insurance link even for a lender that holds an FSP number", () => {
    const html = renderToString(
      <I18nProvider locale="en" messages={{}}>
        <WebsiteIdentityProvider identity={LENDER} jurisdiction={site}><NavBar /></WebsiteIdentityProvider>
      </I18nProvider>,
    )
    expect(html).not.toContain('href="/site/products/insurance"')
    expect(html).toContain('href="/site/calculators"')
  })

  it("home page: no NCR badge, trust badges, insurance card, protections or FAQ, and the loan products stay", () => {
    const html = renderToStaticMarkup(<HomePage identity={LENDER} products={PRODUCTS} site={site} />)
    expect(html).not.toMatch(/South Africa|POPIA|National Credit|\bNCA\b|NCR|FAIS|FSCA|FSP|insurance/i)
    expect(html).not.toContain('href="/site/products/insurance"')
    expect(html).not.toContain("How you&#x27;re protected")
    expect(html).not.toContain("Frequently asked questions")
    expect(html).toContain("Secure portal")
    expect(html).toContain("Personal loan")
    expect(homeFaqs(LENDER, PRODUCTS, "en", site)).toEqual([])
  })
})
