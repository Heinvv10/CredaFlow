import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const h = vi.hoisted(() => ({
  requireRole: vi.fn(), transaction: vi.fn(), tenantConfigFind: vi.fn(),
  requestFind: vi.fn(), requestUpdate: vi.fn(), documentFindUnique: vi.fn(),
  documentFindMany: vi.fn(), documentFindFirst: vi.fn(), clientFind: vi.fn(),
  clientUpdate: vi.fn(), complianceCreate: vi.fn(), auditCreate: vi.fn(),
  lockEvidence: vi.fn(),
}))
const tx = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  tenantConfig: { findUnique: (...a: unknown[]) => h.tenantConfigFind(...a) },
  kycOverrideRequest: {
    findUnique: (...a: unknown[]) => h.requestFind(...a),
    update: (...a: unknown[]) => h.requestUpdate(...a),
  },
  clientDocument: {
    findUnique: (...a: unknown[]) => h.documentFindUnique(...a),
    findMany: (...a: unknown[]) => h.documentFindMany(...a),
    findFirst: (...a: unknown[]) => h.documentFindFirst(...a),
  },
  client: {
    findUnique: (...a: unknown[]) => h.clientFind(...a),
    update: (...a: unknown[]) => h.clientUpdate(...a),
  },
  complianceRecord: { create: (...a: unknown[]) => h.complianceCreate(...a) },
  auditLog: { create: (...a: unknown[]) => h.auditCreate(...a) },
}
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...a: unknown[]) => h.requireRole(...a) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (tenant: { id: string }) => Promise<unknown>) => fn({ id: "tenant-1" }) }))
vi.mock("@/lib/affordability/evidence-locks", () => ({ lockAffordabilityClientEvidence: (...a: unknown[]) => h.lockEvidence(...a) }))
const DATABASE_NOW = new Date("2026-10-14T10:00:00.123Z")
vi.mock("@/lib/db-clock", () => ({ databaseNow: async () => DATABASE_NOW }))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (fn: (client: typeof tx) => Promise<unknown>, options: unknown) => h.transaction(fn, options) } }))

import { PUT } from "./route"

const now = Date.now()
const params = { params: Promise.resolve({ id: "client-1", requestId: "request-1" }) }
const call = (decision: "APPROVED" | "DECLINED" = "APPROVED") => PUT(new NextRequest(
  "http://localhost/api/clients/client-1/kyc-override-requests/request-1",
  { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, reason: "A complete synthetic decision reason." }) },
), params)

const client = {
  id: "client-1", idNumber: "9001010000088", firstName: "Synthetic", lastName: "Client",
  dateOfBirth: new Date("1990-01-01T00:00:00Z"), kycStatus: "FAILED", kycVerifiedAt: null,
  kycVerifiedById: null, kycVerificationMethod: null, kycManualRejectionActive: false,
  kycManualRejectionAt: null, kycManualRejectionById: null, kycManualRejectionReason: null,
  kycManualRejectionResolvedAt: null, kycManualRejectionResolvedById: null,
  kycManualRejectionResolutionReason: null,
}
const selfie = {
  id: "selfie-1", contentSha256: "a".repeat(64), deletedAt: null, verified: false,
  extractionStatus: "failed", extractionResult: null, extractionError: "Face match failed",
  validationMismatch: true, validationScore: 0, biometricMatchScore: 69, biometricLiveness: 90,
  biometricVerifiedAt: null,
  biometricResult: { biometricFailureReason: "match_score_below_threshold", faceModel: { similarity: 0.33 }, faceVerdict: { samePerson: "uncertain" } },
}

describe("PUT /api/clients/[id]/kyc-override-requests/[requestId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireRole.mockResolvedValue({ user: { id: "approver-2", email: "approver@test.invalid", role: "ADMIN", totpVerified: true } })
    h.transaction.mockImplementation((fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
    h.tenantConfigFind.mockResolvedValue({ kycOverrideEnabled: true, kycOverrideMinRole: "ADMIN", kycOverrideSecondApprover: true, requireStaffTotp: true })
    h.requestFind.mockResolvedValue({
      id: "request-1", clientId: "client-1", selfieDocumentId: "selfie-1", kind: "EXCEPTION",
      payload: { reason: "Synthetic request reason is complete.", supportingEvidence: "Synthetic request evidence is complete." },
      requestedById: "requester-1", requestedWithTotp: true,
      requestedBy: { role: "ADMIN", active: true, totpEnabled: true, lastTotpCounter: 1 },
      requestedAt: new Date(now - 1000), status: "PENDING", expiresAt: new Date(now + 86400000),
    })
    h.documentFindUnique.mockResolvedValue({ extractionStatus: selfie.extractionStatus, biometricResult: selfie.biometricResult })
    h.clientFind.mockResolvedValue(client)
    h.documentFindMany.mockResolvedValue(["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"].map((docType) => ({ docType, verified: true })))
    h.documentFindFirst.mockImplementation(async (args: { where: { docType: string } }) => args.where.docType === "SELFIE" ? selfie : { id: "id-1", contentSha256: "b".repeat(64) })
    h.complianceCreate.mockResolvedValue({ id: "exception-1" })
    h.clientUpdate.mockImplementation(async ({ data }: { data: unknown }) => data)
    h.requestUpdate.mockResolvedValue({ id: "request-1" })
    h.auditCreate.mockResolvedValue({ id: "audit-1" })
    h.lockEvidence.mockResolvedValue(undefined)
  })

  it("approves by a different senior, grants VERIFIED in the same transaction, and audits both actions", async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(h.clientUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kycStatus: "VERIFIED", kycVerifiedById: "approver-2" }) }))
    expect(h.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "APPROVED", decidedById: "approver-2" }) }))
    const actions = h.auditCreate.mock.calls.map(([arg]) => arg.data.action)
    expect(actions).toEqual(expect.arrayContaining(["KYC_EXCEPTION_GRANTED", "KYC_OVERRIDE_APPROVED"]))
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith("SET CONSTRAINTS ALL IMMEDIATE")
    expect(h.tenantConfigFind.mock.invocationCallOrder[0]).toBeLessThan(h.lockEvidence.mock.invocationCallOrder[0])
    expect(h.complianceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        completedAt: DATABASE_NOW,
        data: expect.objectContaining({ approvedAt: DATABASE_NOW.toISOString(), approvedWithTotp: true, overrideRequestId: "request-1" }),
      }),
    }))
  })

  it("refuses to grant while a replacement ID copy awaits review", async () => {
    const docs = ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"].map((docType) => ({
      id: `doc-${docType}`, docType, verified: true, createdAt: new Date("2026-07-01T00:00:00Z"),
      verificationRejectedAt: null, verificationRejectedById: null,
    }))
    h.documentFindMany.mockResolvedValue([
      ...docs,
      { id: "id-replacement", docType: "ID_COPY", verified: false, createdAt: new Date("2026-07-02T00:00:00Z"),
        verificationRejectedAt: null, verificationRejectedById: null },
    ])

    const response = await call()

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(h.complianceCreate).not.toHaveBeenCalled()
    expect(h.clientUpdate).not.toHaveBeenCalled()
  })

  it("refuses self-approval before any grant", async () => {
    h.requireRole.mockResolvedValue({ user: { id: "requester-1", email: "requester@test.invalid", role: "ADMIN", totpVerified: true } })
    const response = await call()
    expect(response.status).toBe(403)
    expect(h.complianceCreate).not.toHaveBeenCalled()
  })

  it("refuses approval when overrides were disabled after the request", async () => {
    h.tenantConfigFind.mockResolvedValue({ kycOverrideEnabled: false, kycOverrideMinRole: "ADMIN", kycOverrideSecondApprover: true, requireStaffTotp: true })
    const response = await call()
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe("overrides_disabled")
    expect(h.complianceCreate).not.toHaveBeenCalled()
  })

  it("declines without granting and audits the decision", async () => {
    const response = await call("DECLINED")
    expect(response.status).toBe(200)
    expect(h.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DECLINED" }) }))
    expect(h.complianceCreate).not.toHaveBeenCalled()
    expect(h.auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "KYC_OVERRIDE_DECLINED" }) })
  })

  it("still permits an authorized decline after overrides are disabled", async () => {
    h.tenantConfigFind.mockResolvedValue({ kycOverrideEnabled: false, kycOverrideMinRole: "ADMIN", kycOverrideSecondApprover: true, requireStaffTotp: true })
    const response = await call("DECLINED")
    expect(response.status).toBe(200)
    expect(h.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "DECLINED" }),
    }))
    expect(h.complianceCreate).not.toHaveBeenCalled()
  })

  it("revalidates immutable request payload before granting", async () => {
    h.requestFind.mockResolvedValue({
      ...(await h.requestFind()),
      payload: { reason: "short", supportingEvidence: "short" },
    })
    const response = await call()
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe("invalid_payload")
    expect(h.complianceCreate).not.toHaveBeenCalled()
  })

  it("returns 409 when a policy increase makes the requester too junior", async () => {
    h.requestFind.mockResolvedValue({
      ...(await h.requestFind()),
      requestedBy: { role: "BRANCH_MANAGER", active: true, totpEnabled: true, lastTotpCounter: 1 },
    })
    const response = await call()
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain("Decline this request")
    expect(h.complianceCreate).not.toHaveBeenCalled()
  })

  it("returns 409 when TOTP became required after a request without it", async () => {
    h.requestFind.mockResolvedValue({
      ...(await h.requestFind()),
      requestedWithTotp: false,
      requestedBy: { role: "ADMIN", active: true, totpEnabled: false, lastTotpCounter: null },
    })
    const response = await call()
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain("Decline this request")
    expect(h.complianceCreate).not.toHaveBeenCalled()
  })

  it("expires an overdue request, audits it, and never grants", async () => {
    h.requestFind.mockResolvedValue({
      ...(await h.requestFind()),
      expiresAt: new Date(now - 1000),
    })
    const response = await call()
    expect(response.status).toBe(409)
    expect(h.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "EXPIRED" }) }))
    expect(h.auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "KYC_OVERRIDE_EXPIRED" }) })
    expect(h.complianceCreate).not.toHaveBeenCalled()
  })

  it("returns a retryable conflict for a serialization failure", async () => {
    h.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("conflict", {
      code: "P2034",
      clientVersion: "test",
    }))
    const response = await call()
    expect(response.status).toBe(409)
  })

  it("answers a taken exception key in the exception's terms, not the in-person ones", async () => {
    h.complianceCreate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    }))
    const response = await call()
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body).toMatchObject({ code: "exception_exists" })
    expect(body.error).toContain("senior exception")
  })
})
