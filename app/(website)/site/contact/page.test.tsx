import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"

vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: vi.fn(async () => ACME_LENDER) }))

import ContactPage from "./page"
import ContactLayout, { generateMetadata } from "./layout"

const render = (identity = ACME_LENDER) =>
  renderToStaticMarkup(<WebsiteIdentityProvider identity={identity}><ContactPage /></WebsiteIdentityProvider>)

describe("contact page", () => {
  it("prints the tenant's own contact details and nobody else's", () => {
    const html = render()
    expect(html).toContain("+27 11 000 0000")
    expect(html).toContain("tel:+27110000000")
    expect(html).toContain("hello@acme-lending.example")
    expect(html).toContain("1 Main Road")
    expect(html).toContain("Sandton")
    expect(html).toContain("Acme Lending")
    expectNoOtherLender(html)
  })

  it("hides WhatsApp entirely when the tenant has none", () => {
    const html = render()
    expect(html).not.toContain("wa.me")
    expect(html).not.toContain("WhatsApp")
  })

  it("shows WhatsApp when the tenant has one", () => {
    const html = render({ ...ACME_LENDER, publicWhatsapp: "+27 82 000 0000", publicWhatsappE164: "+27820000000" })
    expect(html).toContain("https://wa.me/27820000000")
    expect(html).toContain("+27 82 000 0000")
  })

  it("links only to pages that still exist", () => {
    const html = render()
    expect(html).not.toMatch(/href="\/(blog|site\/(about|faq|how-it-works|pricing|products\/(credit|capital|personal-loans)))/)
  })
})

describe("contact layout", () => {
  it("emits metadata and JSON-LD for the tenant", async () => {
    const meta = await generateMetadata()
    expect(JSON.stringify(meta)).toContain("Acme Lending")
    const html = renderToStaticMarkup(await ContactLayout({ children: <p>kid</p> }))
    expect(html).toContain("hello@acme-lending.example")
    expectNoOtherLender(html + JSON.stringify(meta))
  })
})
