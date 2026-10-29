import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> }, create: vi.fn(), revoke: vi.fn() }))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/lender-api/oauth/clients", async (orig) => ({
  ...(await orig<typeof import("@/lib/lender-api/oauth/clients")>()),
  createOauthClient: h.create,
  revokeOauthClient: h.revoke,
}))

import { POST } from "./route"
import { DELETE } from "./[id]/route"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "root@lender.example", name: "R", role, tenantId: "t1", totpVerified: true, tokenVersion: 1, ...extra },
})
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/settings/oauth-clients", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
const del = (id: string) => DELETE(new NextRequest(`http://localhost/api/settings/oauth-clients/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) })
const valid = { name: "Core banking", scopes: ["loans:read"], lifetimeDays: 90 }

beforeEach(() => {
  h.session = caller("SUPER_ADMIN")
  h.create.mockReset().mockResolvedValue({ ok: true, clientId: "cfc_0123456789abcdef", secret: "cfs_x", client: { id: "oc1", name: "Core banking", clientId: "cfc_0123456789abcdef", scopes: ["loans:read"], expiresAt: new Date(), requireMtls: false } })
  h.revoke.mockReset().mockResolvedValue("revoked")
})

describe("POST /api/settings/oauth-clients", () => {
  it("creates a client for the caller's lender and returns the secret once, uncached", async () => {
    const res = await post(valid)
    expect(res.status).toBe(201)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toMatchObject({ clientId: "cfc_0123456789abcdef", clientSecret: "cfs_x" })
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", mtls: null, actor: expect.objectContaining({ id: "u1" }) }))
  })

  it.each(["ADMIN", "CREDIT_OFFICER"])("refuses a %s", async (role) => {
    h.session = caller(role)
    expect((await post(valid)).status).toBe(403)
    expect(h.create).not.toHaveBeenCalled()
  })

  it("refuses a session without a CredaFlow code", async () => {
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    expect((await post(valid)).status).toBe(403)
  })

  it.each([
    ["no name", { ...valid, name: " " }],
    ["no scopes", { ...valid, scopes: [] }],
    ["an unknown scope", { ...valid, scopes: ["admin"] }],
    ["a lifetime that is not offered", { ...valid, lifetimeDays: 1000 }],
    ["mutual TLS with no pin", { ...valid, requireMtls: true }],
    ["mutual TLS with only a subject", { ...valid, requireMtls: true, mtlsSubjectDn: "CN=core,O=Bank" }],
    ["mutual TLS with a slash-form subject", { ...valid, requireMtls: true, mtlsSubjectDn: "/CN=core/O=Bank", mtlsCertSha256: "a".repeat(64) }],
    ["mutual TLS with a bad fingerprint", { ...valid, requireMtls: true, mtlsCertSha256: "abc" }],
  ])("refuses %s", async (_l, body) => {
    expect((await post(body)).status).toBe(400)
    expect(h.create).not.toHaveBeenCalled()
  })

  it("passes a certificate pin through", async () => {
    await post({ ...valid, requireMtls: true, mtlsSubjectDn: "CN=core,O=Bank", mtlsCertSha256: "a".repeat(64) })
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ mtls: { subjectDn: "CN=core,O=Bank", certSha256: "a".repeat(64) } }))
  })

  it("passes an allowlist through and refuses a malformed one", async () => {
    await post({ ...valid, ipAllowlist: "198.51.100.0/24\n203.0.113.5" })
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ ipAllowlist: ["198.51.100.0/24", "203.0.113.5"] }))
    h.create.mockClear()
    expect((await post({ ...valid, ipAllowlist: ["bogus"] })).status).toBe(400)
    expect(h.create).not.toHaveBeenCalled()
  })

  it("passes the cap refusal through", async () => {
    h.create.mockResolvedValue({ ok: false, status: 409, error: "At most 20 active OAuth clients." })
    expect((await post(valid)).status).toBe(409)
  })
})

describe("DELETE /api/settings/oauth-clients/[id]", () => {
  it("revokes inside the caller's lender", async () => {
    expect((await del("oc1")).status).toBe(200)
    expect(h.revoke).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", id: "oc1" }))
  })
  it("404s an unknown client and refuses an ADMIN", async () => {
    h.revoke.mockResolvedValue("not_found")
    expect((await del("nope")).status).toBe(404)
    h.session = caller("ADMIN")
    expect((await del("oc1")).status).toBe(403)
  })
})
