import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { authMock, findUnique, findMany, create, transaction, logAuditStrict } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
  logAuditStrict: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findUnique, findMany }, $transaction: transaction } }))
vi.mock("@/lib/audit", () => ({ logAuditStrict, AuditAction: { TENANT_CREATED: "TENANT_CREATED" } }))

import { GET, POST } from "./route"

const post = (body: unknown) => POST(
  new NextRequest("http://localhost/api/admin/tenants", {
    method: "POST", headers: { "x-admin-secret": "s3cret" }, body: JSON.stringify(body),
  }),
)
const BASE = { slug: "beta", name: "Beta Lending" }

describe("POST /api/admin/tenants", () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = "s3cret"
    authMock.mockReset().mockResolvedValue({ user: { id: "u1", email: "root@test.invalid", role: "SUPER_ADMIN" } })
    findUnique.mockReset().mockResolvedValue(null)
    create.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "t2", ...data }))
    transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ tenant: { create }, isTx: true }))
    logAuditStrict.mockReset().mockResolvedValue(undefined)
  })

  it("creates a tenant with a passing colour set and audits it in the same transaction", async () => {
    const colours = { primaryColor: "#1F4E79", secondaryColor: "#245E92", darkColor: "#0F1115" }
    const response = await post({ ...BASE, ...colours })
    expect(response.status).toBe(201)
    expect(create.mock.calls[0][0].data.config).toEqual({ create: colours })
    expect(logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t2", userId: "u1", action: "TENANT_CREATED", entity: "Tenant", entityId: "t2",
      newValue: { slug: "beta", name: "Beta Lending", domain: null, status: "PROVISIONING", ...colours },
    }), expect.objectContaining({ isTx: true }))
  })

  it("defaults omitted colours to the palette's own", async () => {
    expect((await post(BASE)).status).toBe(201)
    expect(create.mock.calls[0][0].data.config).toEqual({ create: { primaryColor: "#4f46e5", secondaryColor: "#4338ca", darkColor: "#0b0d12" } })
  })

  it.each([
    ["a yellow primary", { primaryColor: "#FFD700" }, "primaryColor"],
    ["a light darkColor", { darkColor: "#C0C0C0" }, "darkColor"],
    ["a non-hex string", { secondaryColor: "rgb(0,0,0)" }, "secondaryColor"],
  ])("refuses %s with 422 and creates nothing", async (_label, colours, field) => {
    const response = await post({ ...BASE, ...colours })
    expect(response.status).toBe(422)
    expect(Object.keys((await response.json()).fields)).toEqual([field])
    expect(transaction).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("fails the request when the audit row cannot be written", async () => {
    logAuditStrict.mockRejectedValue(new Error("audit down"))
    await expect(post(BASE)).rejects.toThrow("audit down")
  })

  it("is refused without the super-admin session and the admin secret", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", role: "ADMIN" } })
    expect((await post(BASE)).status).toBe(403)
    expect(transaction).not.toHaveBeenCalled()
  })
})

// Provider credentials never leave in a response, sealed or not (S3).
describe("GET and POST /api/admin/tenants mask provider credentials", () => {
  const SECRET_CONFIG = { netcashKey: "enc:v1:a:b:c", stitchWebhookSecret: "legacy-plaintext", experianKey: null, primaryColor: "#123456" }
  const MASKED_CONFIG = { netcashKey: "********", stitchWebhookSecret: "********", experianKey: "", primaryColor: "#123456" }

  beforeEach(() => {
    process.env.ADMIN_SECRET = "s3cret"
    authMock.mockReset().mockResolvedValue({ user: { id: "u1", email: "root@test.invalid", role: "SUPER_ADMIN" } })
    findUnique.mockReset().mockResolvedValue(null)
    logAuditStrict.mockReset().mockResolvedValue(undefined)
  })

  it("lists tenants with every credential masked", async () => {
    findMany.mockResolvedValue([{ id: "t1", slug: "a", config: SECRET_CONFIG }, { id: "t2", slug: "b", config: null }])
    const res = await GET(new NextRequest("http://localhost/api/admin/tenants", { headers: { "x-admin-secret": "s3cret" } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: "t1", slug: "a", config: MASKED_CONFIG }, { id: "t2", slug: "b", config: null }])
  })

  it("returns the created tenant with its config masked", async () => {
    create.mockReset().mockResolvedValue({ id: "t3", slug: "beta", config: SECRET_CONFIG })
    transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ tenant: { create } }))
    const res = await post(BASE)
    expect(res.status).toBe(201)
    expect((await res.json()).config).toEqual(MASKED_CONFIG)
  })
})
