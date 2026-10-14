import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  transaction: vi.fn(),
  clientFind: vi.fn(),
  selfieFind: vi.fn(),
  requestFind: vi.fn(),
  requestCreate: vi.fn(),
  auditCreate: vi.fn(),
  tenantConfigFind: vi.fn(),
  lockEvidence: vi.fn(),
}))

const tx = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  tenantConfig: { findUnique: (...args: unknown[]) => h.tenantConfigFind(...args) },
  client: { findUnique: (...args: unknown[]) => h.clientFind(...args) },
  clientDocument: { findFirst: (...args: unknown[]) => h.selfieFind(...args) },
  kycOverrideRequest: {
    findFirst: (...args: unknown[]) => h.requestFind(...args),
    create: (...args: unknown[]) => h.requestCreate(...args),
  },
  auditLog: { create: (...args: unknown[]) => h.auditCreate(...args) },
}

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...args: unknown[]) => h.requireRole(...args) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (tenant: { id: string }) => Promise<unknown>) => fn({ id: "tenant-1" }) }))
vi.mock("@/lib/affordability/evidence-locks", () => ({ lockAffordabilityClientEvidence: (...args: unknown[]) => h.lockEvidence(...args) }))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (fn: (client: typeof tx) => Promise<unknown>, options: unknown) => h.transaction(fn, options) } }))

import { POST } from "./route"

const params = { params: Promise.resolve({ id: "client-1" }) }
const request = () => new NextRequest("http://localhost/api/clients/client-1/kyc-override-requests", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    kind: "EXCEPTION",
    reason: "Synthetic senior review reason is complete.",
    supportingEvidence: "Synthetic supporting evidence is complete.",
  }),
})

describe("POST /api/clients/[id]/kyc-override-requests", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireRole.mockResolvedValue({ user: { id: "requester-1", email: "requester@test.invalid", role: "ADMIN", totpVerified: true } })
    h.transaction.mockImplementation((fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
    h.tenantConfigFind.mockResolvedValue({ kycOverrideEnabled: true, kycOverrideMinRole: "ADMIN", kycOverrideSecondApprover: true, requireStaffTotp: true })
    h.clientFind.mockResolvedValue({ id: "client-1" })
    h.selfieFind.mockResolvedValue({
      id: "selfie-1", extractionStatus: "failed",
      biometricResult: { biometricFailureReason: "match_score_below_threshold", faceModel: { similarity: 0.33 }, faceVerdict: { samePerson: "uncertain" } },
    })
    h.requestFind.mockResolvedValue(null)
    h.requestCreate.mockResolvedValue({ id: "request-1", requestedAt: new Date("2026-10-13T12:00:00Z"), expiresAt: new Date("2026-10-20T12:00:00Z") })
    h.auditCreate.mockResolvedValue({ id: "audit-1" })
    h.lockEvidence.mockResolvedValue(undefined)
  })

  it("creates a seven-day request and audits it", async () => {
    const response = await POST(request(), params)
    expect(response.status).toBe(201)
    expect(h.requestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1", clientId: "client-1", selfieDocumentId: "selfie-1",
        kind: "EXCEPTION", requestedById: "requester-1", requestedWithTotp: true,
      }),
      select: { id: true, requestedAt: true, expiresAt: true },
    })
    const createData = h.requestCreate.mock.calls[0][0].data
    expect(createData.expiresAt.getTime() - createData.requestedAt.getTime()).toBe(7 * 86400000)
    expect(h.auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "KYC_OVERRIDE_REQUESTED", entityId: "request-1" }) })
    expect(h.tenantConfigFind.mock.invocationCallOrder[0]).toBeLessThan(h.lockEvidence.mock.invocationCallOrder[0])
  })

  it("returns a retryable conflict for a serialization failure", async () => {
    h.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("conflict", {
      code: "P2034",
      clientVersion: "test",
    }))
    const response = await POST(request(), params)
    expect(response.status).toBe(409)
  })
})
