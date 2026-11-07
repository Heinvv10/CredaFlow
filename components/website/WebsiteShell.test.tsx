import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"

const { identityMock } = vi.hoisted(() => ({ identityMock: vi.fn() }))
vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: () => identityMock() }))
vi.mock("@/lib/tenant", () => ({
  getResolvedTenantId: async () => "tenant_acme",
  getTenantConfig: async (id: string) => (id === "tenant_acme" ? { primaryColor: "#123456", secondaryColor: "#234567", darkColor: "#010203" } : null),
}))
vi.mock("@/lib/config/lender-logo", () => ({ publicLenderLogoSrc: async () => null }))
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: async () => ({}) }))
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }))

import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { WebsiteShell } from "./WebsiteShell"

const render = async () => renderToStaticMarkup(await WebsiteShell({ children: <p>page body</p>, jsonLdId: "site", regulatoryBand: true }))

describe("WebsiteShell", () => {
  it("prints only the tenant's own identity in the nav, regulatory band, footer and JSON-LD", async () => {
    identityMock.mockResolvedValue(ACME_LENDER)
    const html = await render()
    expect(html).toContain("page body")
    expect(html).toContain(":root{--cf-tenant-primary:#123456;--cf-tenant-secondary:#234567;--cf-tenant-dark:#010203;}")
    expect(html).toContain("Acme Lending (Pty) Ltd")
    expect(html).toContain("NCRCP99999")
    expect(html).toContain("12345")
    expect(html).toContain("2020/123456/07")
    expect(html).toContain("hello@acme-lending.example")
    expect(html).toContain("+27 11 000 0000")
    expect(html).toContain('"legalName":"Acme Lending (Pty) Ltd"')
    expectNoOtherLender(html)
  })

  it("leaves WhatsApp out of the structured data when the tenant has no WhatsApp number", async () => {
    identityMock.mockResolvedValue(ACME_LENDER)
    expect(await render()).not.toContain("WhatsApp support")
    identityMock.mockResolvedValue({ ...ACME_LENDER, publicWhatsapp: "+27 82 000 0000", publicWhatsappE164: "+27820000000" })
    expect(await render()).toContain("+27820000000")
  })

  it("renders the not-configured state, and no page, when the identity is not configured", async () => {
    identityMock.mockResolvedValue(null)
    const html = await render()
    expect(html).toContain("not set up yet")
    expect(html).not.toContain("page body")
    expect(html).not.toContain("ld+json")
    expectNoOtherLender(html)
  })
})

describe("WebsiteShell for a lender outside the NCA", () => {
  afterEach(() => resetActiveJurisdiction())

  it("has no regulatory band, insurance link, regulatory link, South African structured data or NCR and FSP line", async () => {
    identityMock.mockResolvedValue(ACME_LENDER)
    const za = await render()
    expect(za).toContain("Regulatory registrations")
    expect(za).toContain("/site/products/insurance")
    expect(za).toContain("/site/regulatory-information")

    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    const html = await render()
    expect(html).toContain("page body")
    expect(html).toContain("Acme Lending (Pty) Ltd")
    expect(html).not.toMatch(/Regulatory registrations|NCR|FSP|FAIS|South Africa|"ZA"|en-ZA|CIPC|\/site\/products\/insurance|\/site\/regulatory-information/)
    expect(html).toContain("Kenya")
  })
})
