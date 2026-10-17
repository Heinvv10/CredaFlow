import { renderToStaticMarkup } from "react-dom/server"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { PortalSidebar } from "./PortalSidebar"
import { buildPortalNavigation } from "@/lib/navigation"
const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }))
vi.mock("next/navigation", () => ({ usePathname: () => "/portal" }))
vi.mock("next-auth/react", () => ({ signOut }))
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a> }))
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }))
const props = { userName: "Test Synthetic", userEmail: "test@example.test", brandName: "Synthetic", whatsappE164: null }
describe("mobile portal full menu", () => {
  it.each([false, true])("offers every allowed destination and sign-out (business=%s)", (showBusiness) => {
    const html = renderToStaticMarkup(<PortalSidebar {...props} showBusiness={showBusiness} />)
    const menu = html.slice(html.indexOf("<details"), html.indexOf("</details>"))
    for (const item of buildPortalNavigation(null, { business: showBusiness })) expect(menu).toContain(`href="${item.href}"`)
    expect(menu).toContain("Sign out")
    expect(menu).toContain("overflow-y-auto")
    expect(menu).toContain("<summary")
  })
  it("signs the mobile client out using the portal return route", () => {
    const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    env.IS_REACT_ACT_ENVIRONMENT = true
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<PortalSidebar {...props} />) })
    const details = renderer.root.findByType("details")
    act(() => details.findByType("button").props.onClick())
    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/portal/login" })
    act(() => renderer.unmount())
    env.IS_REACT_ACT_ENVIRONMENT = false
  })
})
