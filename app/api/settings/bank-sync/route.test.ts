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
// lib/audit is real: the audit row must reach the transaction client
// (logAuditStrict(params, tx)), which is what these tests observe.
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "203.0.113.7" }))

import { GET, PATCH } from "./route"

function patchRequest(body: unknown) {
  return rawPatchRequest(JSON.stringify(body))
}

function rawPatchRequest(body: string) {
  return new NextRequest("http://localhost/api/settings/bank-sync", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
  })
}

function expectNoWrite() {
  expect(transactionMock).not.toHaveBeenCalled()
  expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({
    user: { id: "admin-1", email: "admin@example.test", totpVerified: true },
  })
  tenantConfigFindUniqueMock.mockResolvedValue({ bankSyncEnabled: false })
  tenantConfigUpsertMock.mockResolvedValue({ tenantId: "tenant-1" })
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      tenantConfig: { findUnique: tenantConfigFindUniqueMock, upsert: tenantConfigUpsertMock },
      auditLog: { create: auditLogCreateMock },
    }),
  )
})

describe("PATCH /api/settings/bank-sync", () => {
  it("requires ADMIN and refuses anyone else without writing", async () => {
    requireApiRoleMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })

    const response = await PATCH(patchRequest({ bankSyncEnabled: true }))

    expect(response.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
    expectNoWrite()
  })

  it("refuses an ADMIN whose session did not verify TOTP", async () => {
    for (const totpVerified of [false, undefined]) {
      requireApiRoleMock.mockResolvedValue({
        user: { id: "admin-1", email: "admin@example.test", totpVerified },
      })

      const response = await PATCH(patchRequest({ bankSyncEnabled: true }))

      expect(response.status).toBe(403)
      expectNoWrite()
    }
  })

  it("enables bank sync, scoped to the tenant, and audits BANK_SYNC_ENABLED", async () => {
    const response = await PATCH(patchRequest({ bankSyncEnabled: true }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, bankSyncEnabled: true })
    expect(tenantConfigFindUniqueMock).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      select: { bankSyncEnabled: true },
    })
    expect(tenantConfigUpsertMock).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      update: { bankSyncEnabled: true },
      create: { tenantId: "tenant-1", bankSyncEnabled: true },
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        action: "BANK_SYNC_ENABLED",
        entity: "TenantConfig",
        entityId: "tenant-1",
        userId: "admin-1",
        userEmail: "admin@example.test",
        oldValue: { bankSyncEnabled: false },
        newValue: { bankSyncEnabled: true },
        ipAddress: "203.0.113.7",
      }),
    })
  })

  it("disables bank sync and audits BANK_SYNC_DISABLED", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({ bankSyncEnabled: true })

    const response = await PATCH(patchRequest({ bankSyncEnabled: false }))

    expect(response.status).toBe(200)
    expect(tenantConfigUpsertMock).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      update: { bankSyncEnabled: false },
      create: { tenantId: "tenant-1", bankSyncEnabled: false },
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "BANK_SYNC_DISABLED",
        oldValue: { bankSyncEnabled: true },
        newValue: { bankSyncEnabled: false },
      }),
    })
  })

  it("records the schema default as the old value when no config row exists", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue(null)

    await PATCH(patchRequest({ bankSyncEnabled: true }))

    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ oldValue: { bankSyncEnabled: false } }),
    })
  })

  it.each([
    ["a non-boolean value", { bankSyncEnabled: "yes" }],
    ["a null value", { bankSyncEnabled: null }],
    ["a missing key", {}],
    ["a null body", null],
  ])("rejects %s with 400 without writing", async (_label, body) => {
    const response = await PATCH(patchRequest(body))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "bankSyncEnabled must be true or false." })
    expectNoWrite()
  })

  it("rejects a body that is not JSON with 400 without writing", async () => {
    const response = await PATCH(rawPatchRequest("{not json"))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body." })
    expectNoWrite()
  })

  it("returns 500 and reports no success when the transaction fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    // The audit insert fails inside the transaction, so the whole write rolls
    // back (proved against Postgres in route.integration.test.ts).
    auditLogCreateMock.mockRejectedValue(new Error("audit insert failed"))

    const response = await PATCH(patchRequest({ bankSyncEnabled: true }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: "Failed to update the bank sync setting" })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe("GET /api/settings/bank-sync", () => {
  it("requires ADMIN", async () => {
    requireApiRoleMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })

    const response = await GET(new NextRequest("http://localhost/api/settings/bank-sync"))

    expect(response.status).toBe(403)
    expect(tenantConfigFindUniqueMock).not.toHaveBeenCalled()
  })

  it("reads only this tenant's row and defaults to false without one", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue(null)

    const response = await GET(new NextRequest("http://localhost/api/settings/bank-sync"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ bankSyncEnabled: false })
    expect(tenantConfigFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-1" } }),
    )
  })

  it("returns the stored value", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({ bankSyncEnabled: true })

    const response = await GET(new NextRequest("http://localhost/api/settings/bank-sync"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ bankSyncEnabled: true })
  })

  it("returns 500 when the read fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    tenantConfigFindUniqueMock.mockRejectedValue(new Error("db down"))

    const response = await GET(new NextRequest("http://localhost/api/settings/bank-sync"))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: "Failed to load the bank sync setting" })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
