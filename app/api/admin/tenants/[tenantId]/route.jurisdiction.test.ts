import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { update, configFindUnique, configFindMany } = vi.hoisted(() => ({ update: vi.fn(), configFindUnique: vi.fn(), configFindMany: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "u1", email: "root@test.invalid", role: "SUPER_ADMIN" } }) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: "t1" }), update },
    tenantConfig: { findUnique: configFindUnique, findMany: configFindMany },
  },
}))
vi.mock("@/lib/audit", () => ({ logAuditStrict: vi.fn(), AuditAction: {} }))
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }))

import { PATCH } from "./route"

const patch = (body: unknown) => PATCH(
  new NextRequest("http://localhost/api/admin/tenants/t1", { method: "PATCH", headers: { "x-admin-secret": "s3cret" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ tenantId: "t1" }) },
)

beforeEach(() => {
  process.env.ADMIN_SECRET = "s3cret"
  update.mockReset().mockResolvedValue({ id: "t1", config: {} })
  configFindUnique.mockReset().mockResolvedValue({ jurisdiction: "ZA", currency: "ZAR" })
  configFindMany.mockReset()
})

describe("PATCH status=ACTIVE on a one-jurisdiction instance", () => {
  it("is a 409 when an ACTIVE lender here is Lesotho, and writes nothing", async () => {
    configFindMany.mockResolvedValue([{ jurisdiction: "LS", currency: "LSL", tenant: { slug: "basotho" } }])
    const res = await patch({ status: "ACTIVE" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/basotho=LS\/LSL/)
    expect(update).not.toHaveBeenCalled()
  })

  it("maps the trigger's refusal to a 409 too", async () => {
    configFindMany.mockResolvedValue([])
    update.mockRejectedValue(new Error("One instance serves one jurisdiction: an ACTIVE lender here is x=LS/LSL, this one would be ZA/ZAR. Give that lender its own instance and database."))
    expect((await patch({ status: "ACTIVE" })).status).toBe(409)
  })

  it("lets it through when the instance agrees; other status changes are not checked", async () => {
    configFindMany.mockResolvedValue([{ jurisdiction: "ZA", currency: "ZAR", tenant: { slug: "acme" } }])
    expect((await patch({ status: "ACTIVE" })).status).toBe(200)
    configFindMany.mockClear()
    expect((await patch({ status: "SUSPENDED" })).status).toBe(200)
    expect(configFindMany).not.toHaveBeenCalled()
  })
})
