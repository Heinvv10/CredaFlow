import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { I18nProvider } from "@/lib/i18n/client"
import { WebsiteIdentityProvider } from "./WebsiteIdentity"
import NavBar from "./NavBar"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

const render = (fspNumber: string | null) => renderToString(
  <I18nProvider locale="en" messages={{}}>
    <WebsiteIdentityProvider identity={{ ...ACME_LENDER, fspNumber }}>
      <NavBar />
    </WebsiteIdentityProvider>
  </I18nProvider>,
)

// #143 blind review (LOW): the insurance page 404s for a lender with no FSP
// number, so the main navigation does not link it.
describe("NavBar insurance link", () => {
  it("links the insurance page for a lender that holds an FSP number", () => {
    expect(render("12345")).toContain('href="/site/products/insurance"')
  })

  it("leaves it out for a lender without one", () => {
    expect(render(null)).not.toContain('href="/site/products/insurance"')
  })
})
