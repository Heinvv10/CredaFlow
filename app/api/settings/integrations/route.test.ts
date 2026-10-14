import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const queryRawMock = vi.fn()
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
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb({
      $queryRaw: (query: unknown) => queryRawMock(query),
      tenantConfig: { upsert: (args: unknown) => tenantConfigUpsertMock(args) },
      auditLog: { create: (args: unknown) => auditLogCreateMock(args) },
    }),
  },
}))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "127.0.0.1" }))
const providerSwitchBlockersMock = vi.fn()
const auditRefusalMock = vi.fn()
vi.mock("@/lib/collections-engine/provider-switch", () => ({
  providerSwitchBlockers: (...args: unknown[]) => providerSwitchBlockersMock(...args),
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: (...args: unknown[]) => auditRefusalMock(...args) }))

import { PATCH } from "./route"

describe("PATCH /api/settings/integrations", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
    tenantConfigUpsertMock.mockResolvedValue({ tenantId: "tenant-1" })
    auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
    providerSwitchBlockersMock.mockResolvedValue(null)
    auditRefusalMock.mockResolvedValue(undefined)
  })

  it("serializes a first TenantConfig insert with the lending policy lock", async () => {
    const response = await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          collectionsEngineEnabled: true,
          collectionProvider: "netcash",
          avsProvider: "netcash",
        }),
      },
    ))

    expect(response.status).toBe(200)
    expect(queryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-tenant-policy:tenant-1"],
    }))
    expect(tenantConfigUpsertMock).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      update: {
        collectionsEngineEnabled: true,
        collectionProvider: "netcash",
        avsProvider: "netcash",
      },
      create: {
        tenantId: "tenant-1",
        collectionsEngineEnabled: true,
        collectionProvider: "netcash",
        avsProvider: "netcash",
      },
    })
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      tenantConfigUpsertMock.mock.invocationCallOrder[0],
    )
    expect(tenantConfigUpsertMock.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogCreateMock.mock.invocationCallOrder[0],
    )
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "INTEGRATION_SETTINGS_UPDATED",
        entityId: "tenant-1",
      }),
    })
  })

  it("fails closed when the mandatory integration-settings audit cannot be written", async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collectionsEngineEnabled: true }),
      },
    ))

    expect(response.status).toBe(500)
    expect(tenantConfigUpsertMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
  })

  it("refuses to change the collection provider while it still holds live mandates or open debits, and audits the refusal", async () => {
    providerSwitchBlockersMock.mockResolvedValue({ current: "netcash", mandates: 2, instructions: 1 })
    const response = await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ collectionProvider: "simulated" }) },
    ))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/netcash still holds 2 live mandate.*1 open debit/)
    expect(providerSwitchBlockersMock).toHaveBeenCalledWith("tenant-1", "simulated")
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    expect(auditRefusalMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "COLLECTION_PROVIDER_CHANGE_REFUSED", entity: "TenantConfig", entityId: "tenant-1", tenantId: "tenant-1",
      userId: "admin-1", status: 409, detail: { current: "netcash", requested: "simulated", mandates: 2, instructions: 1 },
    }))
  })

  it("does not consult the collections engine when the provider is not being changed", async () => {
    await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ collectionsEngineEnabled: true }) },
    ))
    expect(providerSwitchBlockersMock).not.toHaveBeenCalled()
  })
})
