import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/tenant", () => ({
  getResolvedTenantId: async () => "tenant-1",
  getTenantConfig: async () => ({ primaryColor: "#123456", secondaryColor: "#ABCDEF", darkColor: "#0A0B0C" }),
}))
vi.mock("@/components/analytics/WebsiteAnalytics", () => ({ WebsiteAnalytics: () => null }))
vi.mock("./PortalRegisterForm", () => ({ default: () => <p>register form</p> }))

import PortalRegisterPage, { dynamic } from "./page"

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
