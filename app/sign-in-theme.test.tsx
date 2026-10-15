import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const { getTenantConfig } = vi.hoisted(() => ({
  getTenantConfig: vi.fn(async (tenantId: string) =>
    tenantId === "tenant-1" ? { primaryColor: "#7A3E1D", secondaryColor: "#8F4A20", darkColor: "#101418" } : null),
}))

vi.mock("@/lib/auth", () => ({ auth: async () => null }))
vi.mock("next/navigation", () => ({ redirect: (p: string) => { throw new Error(`unexpected redirect to ${p}`) } }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: async () => "tenant-1", getTenantConfig }))
vi.mock("@/lib/config/identity", () => ({ getLenderBrandName: async () => "Acme Lending" }))
vi.mock("@/lib/config/deployment-urls", () => ({ DeploymentConfigError: class extends Error {}, requireAppBaseUrl: () => "http://app.test" }))
vi.mock("@/lib/portal-urls", () => ({ portalLoginUrl: () => "http://portal.test/portal/login", safePortalPath: () => null }))
vi.mock("@/components/auth/LoginForm", () => ({ default: () => null }))
vi.mock("@/components/auth/ForgotPasswordForm", () => ({ default: () => null }))
vi.mock("@/components/auth/ResetPasswordForm", () => ({ default: () => null }))
vi.mock("@/components/auth/PortalForgotPasswordForm", () => ({ default: () => null }))
// The lender's portal is on and runs no WhatsApp Cloud; the pages' switch
// behaviour has its own tests (app/portal/*/page.test.tsx).
vi.mock("@/lib/portal/portal-policy", async (orig) => ({
  ...(await orig<typeof import("@/lib/portal/portal-policy")>()),
  isPortalEnabled: async () => true,
}))
vi.mock("@/lib/signing-otp/deliver", () => ({ isWhatsAppCloudConfigured: async () => false }))

import StaffLogin from "./login/page"
import PortalLogin from "./portal/login/page"
import ForgotPassword from "./forgot-password/page"
import ResetPassword from "./reset-password/page"
import PortalForgotPassword from "./portal/forgot-password/page"

// Each sign-in page publishes the request tenant's colours, so it is drawn in
// the lender's palette rather than the default one.
describe("sign-in pages", () => {
  it.each([
    ["/login", () => StaffLogin()],
    ["/portal/login", () => PortalLogin({ searchParams: Promise.resolve({}) })],
    ["/forgot-password", () => ForgotPassword()],
    ["/reset-password", () => ResetPassword()],
    ["/portal/forgot-password", () => PortalForgotPassword()],
  ])("%s renders the request tenant's colours", async (_path, page) => {
    getTenantConfig.mockClear()
    const html = renderToStaticMarkup(await page())
    expect(getTenantConfig).toHaveBeenCalledWith("tenant-1")
    expect(html).toContain("--cf-tenant-primary:#7A3E1D;--cf-tenant-secondary:#8F4A20;--cf-tenant-dark:#101418;")
  })
})
