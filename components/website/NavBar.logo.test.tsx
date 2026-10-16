import { renderToStaticMarkup } from "react-dom/server"
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

const render = (logoSrc: string | null) => renderToStaticMarkup(
  <I18nProvider locale="en" messages={{}}>
    <WebsiteIdentityProvider identity={ACME_LENDER}>
      <NavBar logoSrc={logoSrc} />
    </WebsiteIdentityProvider>
  </I18nProvider>,
)

// Fair Score audit 2026-10-16: the website header showed a text logo only.
describe("website header logo", () => {
  it("shows the lender's uploaded logo", () => {
    const html = render("/api/website/logo?v=abc123")
    expect(html).toContain('src="/api/website/logo?v=abc123"')
    expect(html).toContain(`alt="${ACME_LENDER.tradingName}"`)
  })

  it("keeps the trading name as text without one", () => {
    expect(render(null)).not.toContain("/api/website/logo")
  })
})
