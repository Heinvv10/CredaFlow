import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const tenantConfigUpsertMock = vi.fn()
const auditLogCreateMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    cb: (tenant: { id: string }) => Promise<unknown>,
  ) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: (args: unknown) => tenantConfigFindUniqueMock(args) },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb({
      tenantConfig: {
        findUnique: (args: unknown) => tenantConfigFindUniqueMock(args),
        upsert: (args: unknown) => tenantConfigUpsertMock(args),
      },
      auditLog: { create: (args: unknown) => auditLogCreateMock(args) },
    }),
  },
}))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "127.0.0.1" }))

import { GET, PATCH } from "./route"

function patchReq(body: unknown) {
  return new NextRequest("https://app.acme-lending.example/api/settings/referral-commission", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("/api/settings/referral-commission", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
    tenantConfigFindUniqueMock.mockResolvedValue({ referralCommissionBps: 0 })
    tenantConfigUpsertMock.mockResolvedValue({ tenantId: "tenant-1" })
    auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  })

  // The gate must be on THIS route, not merely on the page that links to it.
  it("requires ADMIN on PATCH", async () => {
    await PATCH(patchReq({ referralCommissionBps: 100 }))
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
  })

  it("requires ADMIN on GET", async () => {
    await GET(new NextRequest("https://app.acme-lending.example/api/settings/referral-commission"))
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
  })

  it("refuses when the role guard rejects, and writes nothing", async () => {
    requireApiRoleMock.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    })
    const res = await PATCH(patchReq({ referralCommissionBps: 100 }))
    expect(res.status).toBe(403)
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("persists a valid rate and returns it", async () => {
    const res = await PATCH(patchReq({ referralCommissionBps: 100 }))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, referralCommissionBps: 100 })
    expect(tenantConfigUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1" },
      update: { referralCommissionBps: 100 },
      create: { tenantId: "tenant-1", referralCommissionBps: 100 },
    }))
  })

  // This rate prices every future accrual; a change with no audit row must not commit.
  it("audits the change with the exact previous value", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({ referralCommissionBps: 250 })
    await PATCH(patchReq({ referralCommissionBps: 100 }))
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "REFERRAL_COMMISSION_RATE_UPDATED",
        entity: "TenantConfig",
        entityId: "tenant-1",
        userId: "admin-1",
        oldValue: { referralCommissionBps: 250 },
        newValue: { referralCommissionBps: 100 },
      }),
    })
  })

  it("records the schema default as the old value when no config row exists", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue(null)
    await PATCH(patchReq({ referralCommissionBps: 100 }))
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ oldValue: { referralCommissionBps: 0 } }),
    })
  })

  it("rejects an invalid rate with 400 and writes nothing", async () => {
    const res = await PATCH(patchReq({ referralCommissionBps: 100.5 }))
    expect(res.status).toBe(400)
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("rejects a malformed JSON body with 400", async () => {
    const res = await PATCH(new NextRequest(
      "https://app.acme-lending.example/api/settings/referral-commission",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{" },
    ))
    expect(res.status).toBe(400)
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
  })

  it("GET hydrates from the stored value", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({ referralCommissionBps: 100 })
    const res = await GET(new NextRequest("https://app.acme-lending.example/api/settings/referral-commission"))
    await expect(res.json()).resolves.toEqual({ referralCommissionBps: 100 })
  })
})
