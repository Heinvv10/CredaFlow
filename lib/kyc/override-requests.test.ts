import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  auditCreate: vi.fn(),
}))

const tx = {
  kycOverrideRequest: {
    findMany: (...args: unknown[]) => h.findMany(...args),
    updateMany: (...args: unknown[]) => h.updateMany(...args),
  },
  auditLog: { create: (...args: unknown[]) => h.auditCreate(...args) },
}

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (fn: (client: typeof tx) => Promise<unknown>, options: unknown) => h.transaction(fn, options) },
}))

import { expireAndListPendingKycOverrideRequests } from "./override-requests"

describe("expireAndListPendingKycOverrideRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.transaction.mockImplementation((fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
    h.findMany
      .mockResolvedValueOnce([{ id: "expired-1" }])
      .mockResolvedValueOnce([{ id: "pending-1", kind: "EXCEPTION" }])
    h.updateMany.mockResolvedValue({ count: 1 })
    h.auditCreate.mockResolvedValue({ id: "audit-1" })
  })

  it("expires and audits stale requests on the application's page read path", async () => {
    const pending = await expireAndListPendingKycOverrideRequests({
      tenantId: "tenant-1",
      clientId: "client-1",
      actor: { id: "viewer-1", email: "viewer@test.invalid" },
    })
    expect(pending).toEqual([{ id: "pending-1", kind: "EXCEPTION" }])
    expect(h.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "EXPIRED", decidedById: "viewer-1" }),
    }))
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "KYC_OVERRIDE_EXPIRED", entityId: "expired-1" }),
    })
    const pendingSelect = h.findMany.mock.calls[1][0].select
    expect(pendingSelect).not.toHaveProperty("payload")
    expect(h.transaction.mock.calls[0][1]).toEqual({ isolationLevel: "ReadCommitted" })
  })

  it("does not audit when a concurrent decision wins the conditional update", async () => {
    h.updateMany.mockResolvedValue({ count: 0 })
    await expireAndListPendingKycOverrideRequests({
      tenantId: "tenant-1",
      clientId: "client-1",
      actor: { id: "viewer-1", email: "viewer@test.invalid" },
    })
    expect(h.auditCreate).not.toHaveBeenCalled()
  })
})
