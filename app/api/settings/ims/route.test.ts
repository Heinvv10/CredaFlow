import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const requireApiRoleMock = vi.fn()
const transactionMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const tenantConfigUpsertMock = vi.fn()
const auditLogCreateMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (role: string) => requireApiRoleMock(role),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) =>
    cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: (args: unknown) => tenantConfigFindUniqueMock(args) },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: {
    IMS_MODULE_ENABLED: "IMS_MODULE_ENABLED",
    IMS_MODULE_DISABLED: "IMS_MODULE_DISABLED",
  },
}))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "127.0.0.1" }))
// Stubbed because the real revalidateTag needs a static generation store that
// does not exist under vitest. Stubbing it also lets the invalidation be
// asserted rather than merely swallowed — without this the route's own
// try/catch would hide a missing call entirely.
const revalidateTagMock = vi.fn()
vi.mock("next/cache", () => ({
  revalidateTag: (...args: unknown[]) => revalidateTagMock(...args),
}))

import { GET, PATCH } from "./route"

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/settings/ims", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({
    user: { id: "admin-1", email: "admin@example.test" },
  })
  tenantConfigFindUniqueMock.mockResolvedValue({ featureIms: false })
  tenantConfigUpsertMock.mockResolvedValue({ tenantId: "tenant-1" })
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      tenantConfig: {
        findUnique: tenantConfigFindUniqueMock,
        upsert: tenantConfigUpsertMock,
      },
      auditLog: { create: auditLogCreateMock },
    }),
  )
})

describe("PATCH /api/settings/ims", () => {
  it("requires ADMIN and refuses anyone else without writing", async () => {
    requireApiRoleMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })

    const response = await PATCH(patchRequest({ featureIms: true }))

    expect(response.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
    expect(transactionMock).not.toHaveBeenCalled()
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("enables the module, scoped to the tenant, and audits IMS_MODULE_ENABLED", async () => {
    const response = await PATCH(patchRequest({ featureIms: true }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, featureIms: true })
    expect(tenantConfigUpsertMock).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      update: { featureIms: true },
      create: { tenantId: "tenant-1", featureIms: true },
    })
    expect(tenantConfigUpsertMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      tenantConfigFindUniqueMock.mock.invocationCallOrder[0],
    )
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        action: "IMS_MODULE_ENABLED",
        entity: "TenantConfig",
        entityId: "tenant-1",
        userId: "admin-1",
        userEmail: "admin@example.test",
        oldValue: { featureIms: false },
        newValue: { featureIms: true },
      }),
    })
  })

  it("disables the module and audits IMS_MODULE_DISABLED", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({ featureIms: true })

    const response = await PATCH(patchRequest({ featureIms: false }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, featureIms: false })
    expect(tenantConfigUpsertMock).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      update: { featureIms: false },
      create: { tenantId: "tenant-1", featureIms: false },
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "IMS_MODULE_DISABLED",
        oldValue: { featureIms: true },
        newValue: { featureIms: false },
      }),
    })
  })

  it("records the schema default as the old value when no config row exists", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue(null)

    const response = await PATCH(patchRequest({ featureIms: true }))

    expect(response.status).toBe(200)
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ oldValue: { featureIms: false } }),
    })
  })

  it("rejects a non-boolean value without writing", async () => {
    const response = await PATCH(patchRequest({ featureIms: "yes" }))

    expect(response.status).toBe(400)
    expect(transactionMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })
})

describe("GET /api/settings/ims", () => {
  it("requires ADMIN", async () => {
    requireApiRoleMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })

    const response = await GET(new NextRequest("http://localhost/api/settings/ims"))

    expect(response.status).toBe(403)
    expect(tenantConfigFindUniqueMock).not.toHaveBeenCalled()
  })

  it("defaults to false when the tenant has no config row", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue(null)

    const response = await GET(new NextRequest("http://localhost/api/settings/ims"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ featureIms: false })
  })
})

describe("cache invalidation", () => {
  // The API gate reads the flag uncached, but the staff nav and the
  // /insurance page redirect read getTenantConfig, which unstable_cache holds
  // under this tag for 300s. Without invalidation, switching OFF leaves those
  // pages reachable for five minutes after their APIs already 404.
  it("invalidates the tenant-config tag for THIS tenant on both directions", async () => {
    for (const enabled of [true, false]) {
      revalidateTagMock.mockClear()
      const response = await PATCH(patchRequest({ featureIms: enabled }))

      expect(response.status).toBe(200)
      expect(revalidateTagMock).toHaveBeenCalledWith("tenant-config-tenant-1", "max")
    }
  })

  it("still reports success when invalidation fails, because the flag is already committed", async () => {
    revalidateTagMock.mockImplementation(() => {
      throw new Error("no static generation store")
    })

    const response = await PATCH(patchRequest({ featureIms: true }))

    // The write is durable at this point. Reporting 500 would tell an operator
    // the module is still on when it is off — worse than a stale nav.
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, featureIms: true })
  })
})
