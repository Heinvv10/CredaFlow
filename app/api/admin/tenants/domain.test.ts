import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// B1 (PR #91): the admin tenants API is the other way Tenant.domain is
// written. It refuses a deployment host or another lender's host, and stores
// the domain normalised.
const h = vi.hoisted(() => ({
  findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn(), auth: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ auth: h.auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: h.findUnique, findFirst: h.findFirst, update: h.update, create: h.create },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ tenant: { create: h.create }, auditLog: { create: async () => ({}) } }),
  },
}))
vi.mock("@/lib/audit", () => ({ logAuditStrict: async () => {}, AuditAction: { TENANT_CREATED: "TENANT_CREATED" } }))
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }))

import { PATCH } from "./[tenantId]/route"
import { POST } from "./route"

const req = (method: string, body: unknown) =>
  new NextRequest("http://localhost/api/admin/tenants/t1", { method, headers: { "x-admin-secret": "s3cret" }, body: JSON.stringify(body) })
const patch = (body: unknown) => PATCH(req("PATCH", body), { params: Promise.resolve({ tenantId: "t1" }) })

beforeEach(() => {
  vi.stubEnv("ADMIN_SECRET", "s3cret")
  vi.stubEnv("OPERATOR_APP_HOST", "console.platform.example")
  vi.stubEnv("TENANT_HOST_MAP", "staff.acme.example=acme")
  h.auth.mockResolvedValue({ user: { id: "u1", email: "root@test.invalid", role: "SUPER_ADMIN" } })
  h.findUnique.mockReset().mockResolvedValue({ id: "t1" })
  h.findFirst.mockReset().mockResolvedValue(null)
  h.update.mockReset().mockResolvedValue({ id: "t1", config: null })
  h.create.mockReset().mockResolvedValue({ id: "t2", slug: "beta", name: "Beta", domain: null, status: "PROVISIONING", config: null })
})
afterEach(() => vi.unstubAllEnvs())

describe("PATCH /api/admin/tenants/[tenantId] — domain", () => {
  it.each(["console.platform.example", "STAFF.ACME.EXAMPLE"])("refuses the deployment host %s and writes nothing", async (domain) => {
    const res = await patch({ domain })
    expect(res.status).toBe(422)
    expect(h.update).not.toHaveBeenCalled()
  })

  it("refuses another lender's subdomain-fallback host", async () => {
    h.findFirst.mockImplementation(async (a: { where: { slug?: string } }) => (a.where.slug === "acme" ? { slug: "acme" } : null))
    expect((await patch({ domain: "acme.lenders.example" })).status).toBe(422)
    expect(h.update).not.toHaveBeenCalled()
  })

  it("stores the domain normalised", async () => {
    expect((await patch({ domain: "  Beta-Lending.Example. " })).status).toBe(200)
    expect(h.update.mock.calls[0][0].data.domain).toBe("beta-lending.example")
  })
})

describe("POST /api/admin/tenants — domain", () => {
  it("refuses the operator console host as a new lender's domain", async () => {
    h.findUnique.mockResolvedValue(null)
    const res = await POST(req("POST", { slug: "beta", name: "Beta", domain: "Console.Platform.Example" }))
    expect(res.status).toBe(422)
    expect(h.create).not.toHaveBeenCalled()
  })
})
