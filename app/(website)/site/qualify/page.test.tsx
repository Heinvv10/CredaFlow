import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"

vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: vi.fn(async () => ACME_LENDER) }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/site/qualify",
}))

import { publicLoanProducts } from "@/lib/public-loan-products"
import QualifyPage from "./page"
import QualifyResult from "./QualifyResult"
import QualifyLayout, { generateMetadata } from "./layout"
import { qualifyFaqs } from "./faqs"

const wrap = (el: React.ReactNode) => <WebsiteIdentityProvider identity={ACME_LENDER}>{el}</WebsiteIdentityProvider>

describe("qualify page", () => {
  it("renders without any other lender", () => {
    const html = renderToStaticMarkup(wrap(<QualifyPage />))
    expect(html).toContain("Acme Lending")
    expectNoOtherLender(html)
  })

  it("FAQs name the tenant and no one else", () => {
    const text = JSON.stringify(qualifyFaqs(ACME_LENDER))
    expect(text).toContain("Acme Lending")
    expectNoOtherLender(text)
  })

  it("result disclaimer prints the tenant's legal name and NCR number", () => {
    const html = renderToStaticMarkup(wrap(
      <QualifyResult incomeCents={2_000_000} expensesCents={500_000} amountRands={3000} termValue={3} products={publicLoanProducts} onRestart={() => {}} />,
    ))
    expect(html).toContain("Acme Lending (Pty) Ltd")
    expect(html).toContain("NCRCP99999")
    expectNoOtherLender(html)
  })
})

describe("qualify layout", () => {
  it("emits tenant metadata and FAQ JSON-LD", async () => {
    const meta = await generateMetadata()
    expect(JSON.stringify(meta)).toContain("Acme Lending")
    const html = renderToStaticMarkup(await QualifyLayout({ children: <p>kid</p> }))
    expect(html).toContain("FAQPage")
    expectNoOtherLender(html + JSON.stringify(meta))
  })
})
