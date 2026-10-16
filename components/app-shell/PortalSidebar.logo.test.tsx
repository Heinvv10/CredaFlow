import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ usePathname: () => "/portal" }))
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }))
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }))

import { PortalSidebar } from "./PortalSidebar"

const render = (logoSrc: string | null) => renderToStaticMarkup(
  <PortalSidebar userName="Synthetic Client" userEmail="c@example.test" brandName="Fair Score" logoSrc={logoSrc} whatsappE164={null} />,
)

// Fair Score audit 2026-10-16: the portal sidebar showed the lender as text only.
describe("PortalSidebar lender logo", () => {
  it("shows the lender's logo, named for screen readers", () => {
    expect(render("/api/website/logo?v=abc123")).toMatch(/<img[^>]*src="\/api\/website\/logo\?v=abc123"[^>]*alt="Fair Score"|<img[^>]*alt="Fair Score"[^>]*src="\/api\/website\/logo\?v=abc123"/)
  })

  it("falls back to the name when there is no logo", () => {
    const html = render(null)
    expect(html).not.toContain("<img")
    expect(html).toContain("Fair Score")
  })
})
