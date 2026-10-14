import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  cookies: vi.fn(),
  headers: vi.fn(),
  session: vi.fn(),
  config: vi.fn(),
  resolvedTenant: vi.fn(),
  clientFindFirst: vi.fn(),
}))

vi.mock("next/headers", () => ({ cookies: () => m.cookies(), headers: () => m.headers() }))
vi.mock("@/lib/auth-session", () => ({ getSession: () => m.session() }))
vi.mock("@/lib/tenant", () => ({ getTenantConfig: (t: string) => m.config(t), getResolvedTenantId: () => m.resolvedTenant() }))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findFirst: m.clientFindFirst } } }))

import { getLocale } from "./server"

function request({ cookie, acceptLanguage }: { cookie?: string; acceptLanguage?: string }) {
  m.cookies.mockResolvedValue({ get: (name: string) => (name === "cf-locale" && cookie ? { value: cookie } : undefined) })
  m.headers.mockResolvedValue(new Headers(acceptLanguage ? { "accept-language": acceptLanguage } : {}))
}

beforeEach(() => {
  vi.clearAllMocks()
  m.session.mockResolvedValue(null)
  m.resolvedTenant.mockResolvedValue("t-host")
  m.config.mockResolvedValue({ enabledLanguages: ["en", "af", "zu", "xh"] })
})

describe("getLocale", () => {
  it("is English outside a request, without touching the session or tenant", async () => {
    m.cookies.mockRejectedValue(new Error("cookies() was called outside a request scope"))
    m.headers.mockRejectedValue(new Error("headers() was called outside a request scope"))
    expect(await getLocale()).toBe("en")
    expect(m.session).not.toHaveBeenCalled()
    expect(m.config).not.toHaveBeenCalled()
  })

  it("follows the cookie, then Accept-Language, for a visitor of the host's tenant", async () => {
    request({ cookie: "af", acceptLanguage: "zu" })
    expect(await getLocale()).toBe("af")
    expect(m.config).toHaveBeenCalledWith("t-host")
    request({ acceptLanguage: "en-GB;q=0.5, xh-ZA" })
    expect(await getLocale()).toBe("xh")
  })

  it("never shows a language the tenant has not enabled", async () => {
    m.config.mockResolvedValue({ enabledLanguages: ["en"] })
    request({ cookie: "af", acceptLanguage: "af" })
    expect(await getLocale()).toBe("en")
    m.config.mockResolvedValue({ enabledLanguages: ["en", "zu"] })
    expect(await getLocale()).toBe("en")
  })

  it("uses a signed-in client's own tenant and stored preference when no cookie decides", async () => {
    m.session.mockResolvedValue({ user: { id: "c1", role: "CLIENT", tenantId: "t1" } })
    m.clientFindFirst.mockResolvedValue({ preferredLanguage: "zu" })
    request({ acceptLanguage: "af" })
    expect(await getLocale()).toBe("zu")
    expect(m.config).toHaveBeenCalledWith("t1")
    expect(m.clientFindFirst).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, select: { preferredLanguage: true } })
  })

  it("does not read the profile when the cookie already decides", async () => {
    m.session.mockResolvedValue({ user: { id: "c1", role: "CLIENT", tenantId: "t1" } })
    request({ cookie: "af" })
    expect(await getLocale()).toBe("af")
    expect(m.clientFindFirst).not.toHaveBeenCalled()
  })
})
