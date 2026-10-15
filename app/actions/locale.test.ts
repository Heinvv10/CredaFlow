import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  session: vi.fn(),
  enabled: vi.fn(),
  resolvedTenant: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("next/headers", () => ({ cookies: async () => ({ set: m.cookieSet }) }))
vi.mock("@/lib/i18n/server", () => ({ loadSession: () => m.session(), getTenantEnabledLocales: (t: string) => m.enabled(t) }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: () => m.resolvedTenant() }))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findFirst: m.findFirst, update: m.update } } }))
vi.mock("@/lib/audit", () => ({ logAudit: m.logAudit, AuditAction: { CLIENT_UPDATED: "CLIENT_UPDATED" } }))

import { setLocaleAction } from "./locale"

const CLIENT = { user: { id: "c1", role: "CLIENT", tenantId: "t1", email: "thandi@example.test" } }

beforeEach(() => {
  vi.clearAllMocks()
  m.enabled.mockResolvedValue(["en", "af", "zu"])
  m.resolvedTenant.mockResolvedValue("t-host")
})

describe("setLocaleAction", () => {
  it("refuses an unknown code and a language the tenant has not enabled, writing nothing", async () => {
    m.session.mockResolvedValue(CLIENT)
    expect(await setLocaleAction("fr")).toEqual({ ok: false, error: "Unknown language" })
    expect(await setLocaleAction("xh")).toEqual({ ok: false, error: "Language not offered" })
    expect(m.cookieSet).not.toHaveBeenCalled()
    expect(m.update).not.toHaveBeenCalled()
  })

  it("for a signed-in client: sets the cookie, stores the preference against their own tenant, audits it", async () => {
    m.session.mockResolvedValue(CLIENT)
    m.findFirst.mockResolvedValue({ preferredLanguage: null })
    expect(await setLocaleAction("zu")).toEqual({ ok: true })
    expect(m.enabled).toHaveBeenCalledWith("t1")
    expect(m.cookieSet).toHaveBeenCalledWith("cf-locale", "zu", expect.objectContaining({ path: "/", httpOnly: true, sameSite: "lax" }))
    expect(m.update).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { preferredLanguage: "zu" } })
    expect(m.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", action: "CLIENT_UPDATED", entity: "Client", entityId: "c1",
      oldValue: { preferredLanguage: null }, newValue: { preferredLanguage: "zu" },
    }))
  })

  it("does not rewrite or audit an unchanged preference", async () => {
    m.session.mockResolvedValue(CLIENT)
    m.findFirst.mockResolvedValue({ preferredLanguage: "af" })
    await setLocaleAction("af")
    expect(m.update).not.toHaveBeenCalled()
    expect(m.logAudit).not.toHaveBeenCalled()
  })

  it("for an anonymous visitor or staff: cookie only, against the host's tenant", async () => {
    m.session.mockResolvedValue(null)
    expect(await setLocaleAction("af")).toEqual({ ok: true })
    expect(m.enabled).toHaveBeenCalledWith("t-host")
    expect(m.cookieSet).toHaveBeenCalledOnce()
    m.session.mockResolvedValue({ user: { id: "u1", role: "ADMIN", tenantId: "t1" } })
    await setLocaleAction("af")
    expect(m.findFirst).not.toHaveBeenCalled()
    expect(m.update).not.toHaveBeenCalled()
  })
})
