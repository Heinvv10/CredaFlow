// app/api/insurance/rate-tables/[id]/retire/route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findFirstTable, updateMany, logAudit } = vi.hoisted(() => ({
  findFirstTable: vi.fn(),
  updateMany: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceRateTable: { findFirst: findFirstTable, updateMany },
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example" },
  }),
}))

vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "table-1" }) }
const url = "http://localhost/api/insurance/rate-tables/table-1/retire"
const req = () => new NextRequest(url, { method: "POST" })

afterEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/insurance/rate-tables/[id]/retire", () => {
  it("404s a table belonging to another tenant", async () => {
    findFirstTable.mockResolvedValue(null)

    const res = await POST(req(), ctx)

    expect(res.status).toBe(404)
    expect(updateMany).not.toHaveBeenCalled()
    expect(findFirstTable.mock.calls[0][0].where).toEqual({ id: "table-1", tenantId: "tenant-1" })
  })

  it("retires an ACTIVE table, stamping effectiveTo", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "ACTIVE", productId: "product-1", version: 2 })
    updateMany.mockResolvedValue({ count: 1 })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(200)
    const call = updateMany.mock.calls[0][0]
    // Guarded by status in the WHERE so a concurrent retire cannot double-stamp.
    expect(call.where).toEqual({ id: "table-1", tenantId: "tenant-1", status: "ACTIVE" })
    expect(call.data.status).toBe("RETIRED")
    expect(call.data.effectiveTo).toBeInstanceOf(Date)
  })

  it("refuses to retire a DRAFT table with 409 — a draft is deleted, not retired", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT", productId: "product-1" })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("refuses to retire an already RETIRED table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "RETIRED", productId: "product-1" })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("409s when the guarded update matched no row (lost the race)", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "ACTIVE", productId: "product-1" })
    updateMany.mockResolvedValue({ count: 0 })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("audits the retirement", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "ACTIVE", productId: "product-1", version: 2 })
    updateMany.mockResolvedValue({ count: 1 })

    await POST(req(), ctx)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "INSURANCE_RATE_TABLE_RETIRED",
        entity: "InsuranceRateTable",
        entityId: "table-1",
      })
    )
  })
})
