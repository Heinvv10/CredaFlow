import { describe, it, expect, vi, beforeEach } from "vitest"

const authMock = vi.fn()
const redirectMock = vi.fn((path: string) => {
  // next/navigation's redirect throws to unwind the render; mimic that so a
  // test can never "pass" by falling through to a second redirect below.
  throw Object.assign(new Error(`NEXT_REDIRECT:${path}`), { digest: `NEXT_REDIRECT;${path}` })
})

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("next/navigation", () => ({ redirect: (p: string) => redirectMock(p) }))
vi.mock("@/components/auth/LoginForm", () => ({ default: () => null }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: async () => "tenant-1", getTenantConfig: async () => null }))
vi.mock("@/lib/config/identity", () => ({ getLenderBrandName: async () => "Acme Lending" }))
const portal = vi.hoisted(() => ({ enabled: true }))
vi.mock("@/lib/portal/portal-policy", async (orig) => ({
  ...(await orig<typeof import("@/lib/portal/portal-policy")>()),
  isPortalEnabled: async () => portal.enabled,
}))

import { renderToStaticMarkup } from "react-dom/server"
import PortalLoginPage from "./page"

describe("PortalLoginPage — lender portal switched off", () => {
  it("shows the unavailable page instead of the sign-in form", async () => {
    portal.enabled = false
    authMock.mockResolvedValue(null)
    const html = renderToStaticMarkup(await PortalLoginPage({ searchParams: Promise.resolve({}) }))
    portal.enabled = true
    expect(html).toContain("The client portal is not available")
  })
})

const CLIENT = { user: { role: "CLIENT", email: "a@b.com" } }
const SIGN = "/portal/agreement/app123"

async function render(session: unknown, callbackUrl?: string) {
  authMock.mockResolvedValue(session)
  try {
    await PortalLoginPage({ searchParams: Promise.resolve({ callbackUrl }) })
    return null
  } catch (err) {
    const digest = (err as { digest?: string }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) {
      return digest.slice("NEXT_REDIRECT;".length)
    }
    throw err
  }
}

describe("PortalLoginPage — already-authenticated redirect", () => {
  beforeEach(() => vi.clearAllMocks())

  // The defect this covers: an authenticated consumer following a deep link
  // ("sign your agreement") was dropped on /portal, losing the destination
  // entirely. Only reproducible with a live session, so curl never saw it.
  it("honours callbackUrl for a signed-in client", async () => {
    expect(await render(CLIENT, SIGN)).toBe(SIGN)
  })

  it("falls back to /portal when no callbackUrl is given", async () => {
    expect(await render(CLIENT)).toBe("/portal")
  })

  it.each([
    ["protocol-relative", "//evil.example/x"],
    ["absolute", "https://evil.example/x"],
    ["backslash escape", "/portal/\\evil.example"],
    ["traversal out of /portal", "/portal/../admin"],
    ["non-portal path", "/dashboard"],
  ])("refuses an unsafe callbackUrl (%s) and falls back to /portal", async (_l, bad) => {
    expect(await render(CLIENT, bad)).toBe("/portal")
  })

  it("sends a signed-in staff user to the dashboard, ignoring callbackUrl", async () => {
    expect(await render({ user: { role: "ADMIN", email: "s@b.com" } }, SIGN)).toBe("/dashboard")
  })

  it("renders the form (no redirect) when there is no session", async () => {
    expect(await render(null, SIGN)).toBeNull()
  })
})
