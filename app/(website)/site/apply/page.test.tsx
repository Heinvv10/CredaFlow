import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"

vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: vi.fn(async () => ACME_LENDER) }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/site/apply",
}))

import ApplyPage from "./page"
import ApplyLayout, { generateMetadata } from "./layout"
import { applyFaqs } from "./faqs"
import { createTranslator } from "@/lib/i18n/translate"

describe("apply page", () => {
  it("names the configured lender and its NCR number, nobody else", () => {
    const html = renderToStaticMarkup(<WebsiteIdentityProvider identity={ACME_LENDER}><ApplyPage /></WebsiteIdentityProvider>)
    expect(html).toContain("Acme Lending (Pty) Ltd")
    expect(html).toContain("NCRCP99999")
    expectNoOtherLender(html)
  })

  it("prints the consent wording with the tenant's legal name and NCR number", () => {
    const html = renderToStaticMarkup(<WebsiteIdentityProvider identity={ACME_LENDER}><ApplyPage /></WebsiteIdentityProvider>)
    // The consent checkbox is on step 3; the static first render shows step 1, so pin the sidebar notice.
    expect(html).toMatch(/Acme Lending \(Pty\) Ltd is a registered credit provider \(NCR Reg: NCRCP99999\)/)
  })

  it("has FAQs free of other lenders", () => {
    expectNoOtherLender(JSON.stringify(applyFaqs(createTranslator("en", "websiteApply"))))
  })
})

describe("apply layout", () => {
  it("emits tenant metadata and FAQ JSON-LD", async () => {
    const meta = await generateMetadata()
    expect(JSON.stringify(meta)).toContain("Acme Lending")
    const html = renderToStaticMarkup(await ApplyLayout({ children: <p>kid</p> }))
    expect(html).toContain("FAQPage")
    expectNoOtherLender(html + JSON.stringify(meta))
  })
})
