import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, it, expect, vi } from "vitest"

const lender = vi.hoisted(() => ({
  policy: { portalEnabled: true, allowNewRegistrations: true, requireSigningOtp: true, signingOtpBranchExempt: true },
  whatsapp: false,
}))

vi.mock("@/lib/tenant", () => ({
  getResolvedTenantId: async () => "tenant-1",
  getTenantConfig: async () => ({ primaryColor: "#123456", secondaryColor: "#ABCDEF", darkColor: "#0A0B0C" }),
}))
vi.mock("@/components/analytics/WebsiteAnalytics", () => ({ WebsiteAnalytics: () => null }))
vi.mock("./PortalRegisterForm", () => ({
  default: ({ whatsappAvailable }: { whatsappAvailable: boolean }) => <p>register form whatsapp={String(whatsappAvailable)}</p>,
}))
vi.mock("@/lib/portal/portal-policy", async (orig) => ({
  ...(await orig<typeof import("@/lib/portal/portal-policy")>()),
  getPortalPolicy: async () => lender.policy,
}))
vi.mock("@/lib/signing-otp/deliver", () => ({ isWhatsAppCloudConfigured: async () => lender.whatsapp }))

import PortalRegisterPage, { dynamic } from "./page"

beforeEach(() => {
  lender.policy = { portalEnabled: true, allowNewRegistrations: true, requireSigningOtp: true, signingOtpBranchExempt: true }
  lender.whatsapp = false
})

describe("PortalRegisterPage — tenant theming", () => {
  it("publishes the resolved tenant's colours around the form", async () => {
    const html = renderToStaticMarkup(await PortalRegisterPage())
    expect(html).toContain(":root{--cf-tenant-primary:#123456;--cf-tenant-secondary:#ABCDEF;--cf-tenant-dark:#0A0B0C;}")
    expect(html).toContain("register form")
  })

  it("is rendered per request, since the tenant is resolved from the request", () => {
    expect(dynamic).toBe("force-dynamic")
  })
})

describe("PortalRegisterPage — lender switches", () => {
  it("offers WhatsApp only when the lender runs WhatsApp Cloud", async () => {
    expect(renderToStaticMarkup(await PortalRegisterPage())).toContain("whatsapp=false")
    lender.whatsapp = true
    expect(renderToStaticMarkup(await PortalRegisterPage())).toContain("whatsapp=true")
  })

  it("shows 'registrations are closed' instead of the form while registrations are off", async () => {
    lender.policy = { ...lender.policy, allowNewRegistrations: false }
    const html = renderToStaticMarkup(await PortalRegisterPage())
    expect(html).toContain("Registrations are closed")
    expect(html).not.toContain("register form")
  })

  it("shows the portal-unavailable page while the portal is off", async () => {
    lender.policy = { ...lender.policy, portalEnabled: false }
    const html = renderToStaticMarkup(await PortalRegisterPage())
    expect(html).toContain("The client portal is not available")
    expect(html).not.toContain("register form")
  })
})
