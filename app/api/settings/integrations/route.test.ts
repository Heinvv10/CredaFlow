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

import { randomBytes } from "node:crypto"
import { PATCH } from "./route"
import { openCredential } from "@/lib/integrations/tenant-credentials"

describe("PATCH /api/settings/integrations", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
    tenantConfigUpsertMock.mockResolvedValue({ tenantId: "tenant-1" })
    auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
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

  const patch = (body: Record<string, unknown>) => PATCH(new NextRequest(
    "https://staging.acme-lending.example/api/settings/integrations",
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  ))

  it("seals every provider credential before it is stored, and audits the field names only", async () => {
    vi.stubEnv("WABA_ENC_KEY", randomBytes(32).toString("base64"))
    try {
      const response = await patch({ experianKey: "synthetic-user:synthetic-pass", stitchWebhookSecret: "synthetic-whsec" })
      expect(response.status).toBe(200)
      const { update } = tenantConfigUpsertMock.mock.calls[0][0] as { update: Record<string, string> }
      expect(update.experianKey.startsWith("enc:v1:")).toBe(true)
      expect(openCredential(update.experianKey)).toBe("synthetic-user:synthetic-pass")
      expect(openCredential(update.stitchWebhookSecret)).toBe("synthetic-whsec")
      const audit = JSON.stringify(auditLogCreateMock.mock.calls[0][0])
      expect(audit).toContain("experianKey")
      expect(audit).not.toContain("synthetic-pass")
      expect(audit).not.toContain("synthetic-whsec")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("refuses to store a credential in plaintext when no key is configured", async () => {
    vi.stubEnv("WABA_ENC_KEY", "")
    try {
      const response = await patch({ netcashKey: "synthetic-service-key" })
      expect(response.status).toBe(500)
      expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
