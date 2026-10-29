import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  count: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/prisma", () => {
  const tx = {
    apiKey: { count: h.count, create: h.create, updateMany: h.updateMany, findFirst: h.findFirst },
    auditLog: { create: h.audit },
  }
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { POST } from "./route"
import { DELETE } from "./[id]/route"
import { hashApiKey } from "@/lib/lender-api/keys"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "admin-1", email: "admin@lender.example", name: "A", role, tenantId: "t1", totpVerified: true, tokenVersion: 1, ...extra },
})
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/settings/api-keys", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))
const del = (id: string) => DELETE(new NextRequest(`http://localhost/api/settings/api-keys/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) })
const valid = { name: "Warehouse", scopes: ["loans:read", "pii:read"], lifetimeDays: 90 }

beforeEach(() => {
  h.session = caller("ADMIN")
  h.count.mockReset().mockResolvedValue(0)
  h.create.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "key-1", name: data.name, prefix: data.prefix, scopes: data.scopes, expiresAt: data.expiresAt,
  }))
  h.updateMany.mockReset().mockResolvedValue({ count: 1 })
  h.findFirst.mockReset().mockResolvedValue(null)
  h.audit.mockReset().mockResolvedValue({})
})

describe("POST /api/settings/api-keys", () => {
  it("creates a key for the caller's tenant, returns it once, stores only its hash, and audits", async () => {
    const res = await post(valid)
    expect(res.status).toBe(201)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    const stored = h.create.mock.calls[0][0].data
    expect(body.key).toMatch(/^cfk_/)
    expect(stored).toMatchObject({ tenantId: "t1", createdById: "admin-1", scopes: ["loans:read", "pii:read"], keyHash: hashApiKey(body.key) })
    expect(JSON.stringify(stored)).not.toContain(body.key)
    const expiresInDays = (stored.expiresAt.getTime() - stored.createdAt.getTime()) / 86_400_000
    expect(expiresInDays).toBe(90)
    const audit = h.audit.mock.calls[0][0].data
    expect(audit).toMatchObject({ tenantId: "t1", userId: "admin-1", action: "API_KEY_CREATED", entity: "ApiKey", entityId: "key-1" })
    expect(JSON.stringify(audit)).not.toContain(body.key)
  })

  it("stores and audits an optional source-address allowlist, and refuses a malformed one", async () => {
    expect((await post({ ...valid, ipAllowlist: ["198.51.100.0/24", "2001:db8::/32"] })).status).toBe(201)
    expect(h.create.mock.calls[0][0].data.ipAllowlist).toEqual(["198.51.100.0/24", "2001:db8::/32"])
    expect(h.audit.mock.calls[0][0].data.newValue.ipAllowlist).toEqual(["198.51.100.0/24", "2001:db8::/32"])
    h.create.mockClear()
    for (const bad of [["not an ip"], ["10.0.0.0/33"], "300.1.1.1"]) {
      expect((await post({ ...valid, ipAllowlist: bad })).status).toBe(400)
    }
    expect(h.create).not.toHaveBeenCalled()
  })

  it("defaults to no restriction", async () => {
    await post(valid)
    expect(h.create.mock.calls[0][0].data.ipAllowlist).toEqual([])
  })

  it("is for ADMIN and above only", async () => {
    for (const role of ["READONLY", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER"]) {
      h.session = caller(role)
      expect((await post(valid)).status, role).toBe(403)
    }
    h.session = null
    expect((await post(valid)).status).toBe(401)
    h.session = caller("SUPER_ADMIN")
    expect((await post(valid)).status).toBe(201)
  })

  it("needs a TOTP-verified session", async () => {
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    const res = await post(valid)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/two-factor/)
    expect(h.create).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...valid, name: "" }],
    [{ ...valid, scopes: [] }],
    [{ ...valid, scopes: ["loans:write"] }],
    [{ ...valid, lifetimeDays: 3650 }],
  ])("refuses an invalid request %#", async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(h.create).not.toHaveBeenCalled()
  })

  it("caps the number of active keys", async () => {
    h.count.mockResolvedValue(20)
    expect((await post(valid)).status).toBe(409)
    expect(h.create).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/settings/api-keys/[id]", () => {
  it("revokes a key of the caller's tenant only, and audits", async () => {
    const res = await del("key-1")
    expect(res.status).toBe(200)
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: "key-1", tenantId: "t1", revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedById: "admin-1" },
    })
    expect(h.audit.mock.calls[0][0].data).toMatchObject({ action: "API_KEY_REVOKED", entityId: "key-1", tenantId: "t1" })
  })

  it("answers 404 for a key that is not the tenant's, and writes nothing", async () => {
    h.updateMany.mockResolvedValue({ count: 0 })
    expect((await del("other-tenant-key")).status).toBe(404)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("needs ADMIN with 2FA", async () => {
    h.session = caller("ADMIN", { totpVerified: false })
    expect((await del("key-1")).status).toBe(403)
    h.session = caller("BRANCH_MANAGER")
    expect((await del("key-1")).status).toBe(403)
    expect(h.updateMany).not.toHaveBeenCalled()
  })
})
