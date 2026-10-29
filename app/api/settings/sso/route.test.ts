import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> }, save: vi.fn(), get: vi.fn() }))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/sso/connection", async (orig) => ({
  ...(await orig<typeof import("@/lib/sso/connection")>()),
  saveConnection: h.save,
  getConnection: h.get,
}))

import { GET, PUT } from "./route"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "root@lender.example", name: "R", role, tenantId: "t1", totpVerified: true, tokenVersion: 1, ...extra },
})
const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/settings/sso", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
const get = () => GET(new NextRequest("http://localhost/api/settings/sso"))

beforeEach(() => {
  h.session = caller("SUPER_ADMIN")
  h.save.mockReset().mockResolvedValue({ ok: true, connection: { protocol: "OIDC" } })
  h.get.mockReset().mockResolvedValue(null)
})

describe("PUT /api/settings/sso", () => {
  it("saves for a Super Admin in a TOTP-verified session, as that actor", async () => {
    const res = await put({ protocol: "OIDC" })
    expect(res.status).toBe(200)
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", actor: expect.objectContaining({ id: "u1", email: "root@lender.example" }) }))
  })

  it.each(["ADMIN", "LOAN_ADMIN", "CREDIT_OFFICER", "READONLY"])("refuses a %s", async (role) => {
    h.session = caller(role)
    expect((await put({})).status).toBe(403)
    expect(h.save).not.toHaveBeenCalled()
  })

  it("refuses a Super Admin whose sign-in did not verify a CredaFlow code (provider MFA does not count)", async () => {
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    const res = await put({})
    expect(res.status).toBe(403)
    expect(h.save).not.toHaveBeenCalled()
  })

  it("refuses an anonymous caller and a client session", async () => {
    h.session = null
    expect((await put({})).status).toBe(401)
    h.session = caller("CLIENT")
    expect((await put({})).status).toBe(403)
  })

  it("returns the validation message and status the store gives", async () => {
    h.save.mockResolvedValue({ ok: false, status: 400, error: "Choose OIDC or SAML." })
    const res = await put({})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Choose OIDC or SAML." })
  })
})

describe("GET /api/settings/sso", () => {
  it("is for the same callers and is never cached", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    h.session = caller("ADMIN")
    expect((await get()).status).toBe(403)
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    expect((await get()).status).toBe(403)
  })
})
