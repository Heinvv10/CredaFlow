import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const transactionMock = vi.fn()
const queryRawMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const tenantConfigUpsertMock = vi.fn()
const auditLogCreateMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: () => requireApiRoleMock(),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) =>
    cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: { CREDIT_POLICY_UPDATED: "CREDIT_POLICY_UPDATED" },
}))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "127.0.0.1" }))

import { PATCH } from "./route"

function patchRequest() {
  return new NextRequest("http://localhost/api/settings/credit-policy", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bureauMinScore: 600,
      bureauBlockAdverse: true,
      ndiBufferPct: 120,
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({
    user: { id: "admin-1", email: "admin@example.test" },
  })
  queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
  tenantConfigFindUniqueMock.mockResolvedValue({
    bureauMinScore: 450,
    bureauBlockAdverse: false,
    ndiBufferPct: 110,
  })
  tenantConfigUpsertMock.mockResolvedValue({ tenantId: "tenant-1" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({
    $queryRaw: queryRawMock,
    tenantConfig: {
      findUnique: tenantConfigFindUniqueMock,
      upsert: tenantConfigUpsertMock,
    },
    auditLog: { create: auditLogCreateMock },
  }))
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
})

describe("PATCH /api/settings/credit-policy", () => {
  it("takes the tenant policy lock before reading or upserting decision inputs", async () => {
    const response = await PATCH(patchRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      bureauMinScore: 600,
      bureauBlockAdverse: true,
      ndiBufferPct: 120,
    })
    expect(queryRawMock).toHaveBeenCalledTimes(1)
    expect(queryRawMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ values: ["affordability-tenant-policy:tenant-1"] }),
    )
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      tenantConfigFindUniqueMock.mock.invocationCallOrder[0],
    )
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      tenantConfigUpsertMock.mock.invocationCallOrder[0],
    )
    expect(tenantConfigUpsertMock.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogCreateMock.mock.invocationCallOrder[0],
    )
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CREDIT_POLICY_UPDATED",
        entityId: "tenant-1",
      }),
    })
  })

  it("fails closed when the mandatory policy audit cannot be written", async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await PATCH(patchRequest())

    expect(response.status).toBe(500)
    expect(tenantConfigUpsertMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
  })
})
