import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { transaction, findUnique, update, auditCreate, requireApiRole } = vi.hoisted(() => ({
  transaction: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  auditCreate: vi.fn(),
  requireApiRole: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: transaction,
  },
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: NextRequest, callback: (tenant: { id: string }) => unknown) =>
    callback({ id: "tenant-1" }),
}))

import { PATCH } from "./route"

describe("PATCH /api/applications/[id]/compliance", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({
      error: null,
      user: { id: "staff-1", email: "officer@acme-lending.example" },
    })
    findUnique.mockResolvedValue({ id: "app-1" })
    update.mockResolvedValue({ id: "app-1" })
    auditCreate.mockResolvedValue({ id: "audit-1" })
    transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      loanApplication: { findUnique, update },
      auditLog: { create: auditCreate },
    }))
  })

  it("attributes the compliance audit to both the staff id and email", async () => {
    const req = new NextRequest("http://localhost/api/applications/app-1/compliance", {
      method: "PATCH",
      body: JSON.stringify({ recklessLendingAssessed: true }),
      headers: { "content-type": "application/json" },
    })

    const res = await PATCH(req, { params: Promise.resolve({ id: "app-1" }) })

    expect(res.status).toBe(200)
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        action: "COMPLIANCE_UPDATED",
        entityId: "app-1",
        userId: "staff-1",
        userEmail: "officer@acme-lending.example",
      }),
    })
  })

  describe("on a key-facts application", () => {
    const patch = (body: object) => PATCH(new NextRequest("http://localhost/api/applications/app-1/compliance", {
      method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "app-1" }) })

    it.each([
      ["recklessLendingAssessed", { recklessLendingAssessed: true }],
      ["recklessLendingAssessed false", { recklessLendingAssessed: false }],
      ["clientAffordabilityDeclared", { clientAffordabilityDeclared: true }],
    ])("refuses %s with a 422, writes nothing to the application, and audits the attempt", async (_label, body) => {
      findUnique.mockResolvedValue({ id: "app-1", disclosureRegime: "KEY_FACTS" })
      const res = await patch(body)
      expect(res.status).toBe(422)
      expect(update).not.toHaveBeenCalled()
      expect(auditCreate).toHaveBeenCalledTimes(1)
      expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
        tenantId: "tenant-1", action: "COMPLIANCE_UPDATE_REFUSED", entityId: "app-1", userId: "staff-1", userEmail: "officer@acme-lending.example",
        newValue: expect.objectContaining({ reason: "KEY_FACTS" }),
      }) })
    })

    it("an NCA_PASQ application stamps as before", async () => {
      findUnique.mockResolvedValue({ id: "app-1", disclosureRegime: "NCA_PASQ" })
      const res = await patch({ recklessLendingAssessed: true, clientAffordabilityDeclared: true })
      expect(res.status).toBe(200)
      expect(update.mock.calls[0][0].data).toMatchObject({ recklessLendingAssessed: true, recklessLendingAssessedById: "staff-1", clientAffordabilityDeclaredAt: expect.any(Date) })
      expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "COMPLIANCE_UPDATED" }) })
    })
  })

  it("rejects a staff-forged PASQ acknowledgement before any transaction", async () => {
    const req = new NextRequest("http://localhost/api/applications/app-1/compliance", {
      method: "PATCH",
      body: JSON.stringify({ pasqAcknowledged: true }),
      headers: { "content-type": "application/json" },
    })

    const res = await PATCH(req, { params: Promise.resolve({ id: "app-1" }) })

    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/client must open and acknowledge/i)
    expect(transaction).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("fails the transaction when compliance audit evidence cannot be written", async () => {
    auditCreate.mockRejectedValue(new Error("audit unavailable"))
    const req = new NextRequest("http://localhost/api/applications/app-1/compliance", {
      method: "PATCH",
      body: JSON.stringify({ recklessLendingAssessed: true }),
      headers: { "content-type": "application/json" },
    })

    const res = await PATCH(req, { params: Promise.resolve({ id: "app-1" }) })

    expect(res.status).toBe(500)
    expect(update).toHaveBeenCalledOnce()
    expect(auditCreate).toHaveBeenCalledOnce()
    expect(transaction).toHaveBeenCalledOnce()
  })

  it("returns 404 without updating or auditing a missing application", async () => {
    findUnique.mockResolvedValue(null)
    const req = new NextRequest("http://localhost/api/applications/missing/compliance", {
      method: "PATCH",
      body: JSON.stringify({ recklessLendingAssessed: true }),
      headers: { "content-type": "application/json" },
    })

    const res = await PATCH(req, { params: Promise.resolve({ id: "missing" }) })

    expect(res.status).toBe(404)
    expect(update).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })
})
