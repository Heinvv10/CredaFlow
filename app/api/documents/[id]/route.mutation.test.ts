import { beforeEach, describe, expect, it, vi } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "@/lib/kyc/face-model/evidence.test-helpers"

const biometricSubject = {
  id: "client-1",
  idNumber: "9001015000086",
  firstName: "Synthetic",
  lastName: "Customer",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
}

const passingSelfieDocument = {
  id: "selfie-current",
  deletedAt: null,
  verified: true,
  extractionStatus: "done",
  extractionResult: {
    faceDetected: { value: true },
    facesCount: { value: 1 },
    isLive: { value: true },
    quality: { value: "good" },
  },
  extractionError: null,
  validationMismatch: false,
  validationScore: 98,
  biometricMatchScore: 98,
  biometricLiveness: 97,
  biometricVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
  biometricResult: {
    ok: true,
    verified: true,
    matchScore: 98,
    livenessScore: 97,
    provider: "vlm-face-match-v3",
    faceModel: PASSING_FACE_MODEL_EVIDENCE,
    idPhotoKind: "photograph",
    idPhotoIsRealPhotograph: true,
    idPhotoFaceDetected: true,
    selfieIsRealPhotograph: true,
    samePerson: "same",
    faceMatch: true,
    matchConfidence: 0.98,
    livenessConfidence: 0.97,
    idDocumentId: "id-doc-1",
    idDocumentSha256: "c".repeat(64),
    subjectFingerprint: biometricSubjectFingerprint(biometricSubject),
  },
}

const clientDocumentFindFirstMock = vi.fn()
const clientDocumentFindManyMock = vi.fn()
const clientDocumentUpdateManyMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const clientUpdateMock = vi.fn()
const auditCreateMock = vi.fn()
const queryRawMock = vi.fn()
const getDocumentCallerMock = vi.fn()
const deleteFileMock = vi.fn()
const loanApplicationFindFirstMock = vi.fn()
const paymentNotificationFindFirstMock = vi.fn()

const tx = {
  $queryRaw: (query: unknown) => queryRawMock(query),
  clientDocument: {
    findFirst: (args: unknown) => clientDocumentFindFirstMock(args),
    findMany: (args: unknown) => clientDocumentFindManyMock(args),
    updateMany: (args: unknown) => clientDocumentUpdateManyMock(args),
  },
  client: {
    findUnique: (args: unknown) => clientFindUniqueMock(args),
    update: (args: unknown) => clientUpdateMock(args),
  },
  auditLog: { create: (args: unknown) => auditCreateMock(args) },
  loanApplication: { findFirst: (args: unknown) => loanApplicationFindFirstMock(args) },
  paymentNotification: { findFirst: (args: unknown) => paymentNotificationFindFirstMock(args) },
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: {
      findFirst: (args: unknown) => clientDocumentFindFirstMock(args),
    },
    $transaction: (cb: (client: typeof tx) => Promise<unknown>) => cb(tx),
  },
}))
vi.mock("@/lib/storage", () => ({
  deleteFile: (...args: unknown[]) => deleteFileMock(...args),
  readFile: vi.fn(),
}))
vi.mock("@/lib/document-auth", () => ({
  getDocumentCaller: () => getDocumentCallerMock(),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    cb: (tenant: { id: string }) => Promise<unknown>,
  ) => cb({ id: "tenant-1" }),
}))

import * as documentRoute from "./route"

const { DELETE } = documentRoute

const ctx = { params: Promise.resolve({ id: "doc-1" }) }
const document = {
  id: "doc-1",
  tenantId: "tenant-1",
  clientId: "client-1",
  deletedAt: null,
  docType: "BANK_STATEMENT",
  verified: true,
  verifiedAt: new Date("2026-07-20T08:00:00.000Z"),
  verifiedById: "officer-previous",
  verificationNote: null,
  storagePath: "tenant-1/client-1/doc-1.pdf",
}

describe("document evidence mutations", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // SUPER_ADMIN because deletion is now restricted to that role. These tests
    // are about the deletion MECHANICS (evidence lock, KYC recomputation, audit
    // fail-closed, statutory immutability), so they must run as a caller who
    // gets past the role gate — otherwise every one of them would pass on a
    // 403 and prove nothing about the code it names. The role gate itself is
    // covered in route.test.ts.
    getDocumentCallerMock.mockResolvedValue({
      type: "staff",
      userId: "staff-1",
      role: "SUPER_ADMIN",
      email: "staff@example.test",
    })
    clientDocumentFindFirstMock
      .mockResolvedValueOnce(document)
      .mockResolvedValueOnce(document)
      .mockResolvedValue(passingSelfieDocument)
    clientDocumentUpdateManyMock.mockResolvedValue({ count: 1 })
    clientDocumentFindManyMock.mockResolvedValue([
      { id: "id-doc-1", docType: "ID_COPY", verified: true, verificationNote: null, contentSha256: "c".repeat(64) },
      { docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
      { docType: "PAYSLIP", verified: true, verificationNote: null },
    ])
    clientFindUniqueMock.mockResolvedValue({
      ...biometricSubject,
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
      kycVerifiedById: "officer-previous",
      kycVerificationMethod: "PHYSICAL",
    })
    clientUpdateMock.mockResolvedValue({
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    })
    auditCreateMock.mockResolvedValue({ id: "audit-1" })
    queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
    deleteFileMock.mockResolvedValue(undefined)
  })

  it("soft-deletes under the client evidence lock before removing the file", async () => {
    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", {
        method: "DELETE",
      }),
      ctx,
    )

    expect(response.status).toBe(200)
    expect(queryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-client:tenant-1:client-1"],
    }))
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      clientDocumentUpdateManyMock.mock.invocationCallOrder[0],
    )
    expect(clientDocumentUpdateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFileMock.mock.invocationCallOrder[0],
    )
    expect(clientUpdateMock).toHaveBeenCalledWith({
      where: { id: "client-1", tenantId: "tenant-1" },
      data: {
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
      select: expect.objectContaining({
        kycStatus: true,
        kycVerifiedAt: true,
        kycVerifiedById: true,
        kycVerificationMethod: true,
      }),
    })
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "DOCUMENT_DELETED",
        entity: "ClientDocument",
        entityId: "doc-1",
        oldValue: expect.objectContaining({
          document: expect.objectContaining({
            docType: "BANK_STATEMENT",
            verified: true,
          }),
          clientKyc: {
            kycStatus: "VERIFIED",
            kycVerifiedAt: "2026-07-20T08:00:00.000Z",
            kycVerifiedById: "officer-previous",
            kycVerificationMethod: "PHYSICAL",
          },
        }),
        newValue: expect.objectContaining({
          document: expect.objectContaining({ deletedAt: expect.any(String) }),
          clientKyc: {
            kycStatus: "PENDING",
            kycVerifiedAt: null,
            kycVerifiedById: null,
            kycVerificationMethod: null,
          },
        }),
      }),
    })
    expect(auditCreateMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFileMock.mock.invocationCallOrder[0],
    )
  })

  it("fails KYC when the newest selfie attempt is deleted instead of reviving older evidence", async () => {
    const failedSelfie = {
      ...document,
      docType: "SELFIE",
      verified: false,
      verifiedAt: null,
      verifiedById: null,
      verificationNote: "Biometric verification failed",
      storagePath: "tenant-1/client-1/selfie.jpg",
    }
    clientDocumentFindFirstMock.mockReset()
      .mockResolvedValueOnce(failedSelfie)
      .mockResolvedValueOnce(failedSelfie)
      .mockResolvedValueOnce({ id: "doc-1" })
      .mockResolvedValueOnce({
        ...failedSelfie,
        deletedAt: new Date("2026-07-22T12:00:00.000Z"),
        extractionStatus: "failed",
        extractionResult: null,
        extractionError: "Biometric verification failed",
        validationMismatch: true,
        validationScore: 0,
        biometricMatchScore: null,
        biometricLiveness: null,
        biometricVerifiedAt: null,
        biometricResult: null,
      })
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
      kycVerifiedById: "officer-previous",
      kycVerificationMethod: "SMILE_IDENTITY",
    })
    clientUpdateMock.mockResolvedValueOnce({
      kycStatus: "FAILED",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    })

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", {
        method: "DELETE",
      }),
      ctx,
    )

    expect(response.status).toBe(200)
    expect(clientDocumentFindFirstMock.mock.calls[2][0]).toEqual({
      where: {
        tenantId: "tenant-1",
        clientId: "client-1",
        docType: "SELFIE",
      },
      orderBy: [
        { biometricAttemptSequence: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: { id: true },
    })
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "FAILED",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    }))
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        newValue: expect.objectContaining({
          document: expect.objectContaining({ latestBiometricAttempt: true }),
          clientKyc: {
            kycStatus: "FAILED",
            kycVerifiedAt: null,
            kycVerifiedById: null,
            kycVerificationMethod: null,
          },
        }),
      }),
    })
  })

  it("preserves Smile provenance when deleting redundant core evidence leaves composite KYC complete", async () => {
    const smileVerifiedAt = new Date("2026-07-20T08:00:00.000Z")
    clientDocumentFindManyMock.mockResolvedValueOnce([
      { id: "id-doc-1", docType: "ID_COPY", verified: true, verificationNote: null, contentSha256: "c".repeat(64) },
      { docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
      { docType: "PAYSLIP", verified: true, verificationNote: null },
      { docType: "BANK_STATEMENT", verified: true, verificationNote: null },
    ])
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "VERIFIED",
      kycVerifiedAt: smileVerifiedAt,
      kycVerifiedById: null,
      kycVerificationMethod: "SMILE_IDENTITY",
    })
    clientUpdateMock.mockResolvedValueOnce({
      kycStatus: "VERIFIED",
      kycVerifiedAt: smileVerifiedAt,
      kycVerifiedById: null,
      kycVerificationMethod: "SMILE_IDENTITY",
    })

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", {
        method: "DELETE",
      }),
      ctx,
    )

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: smileVerifiedAt,
        kycVerifiedById: null,
        kycVerificationMethod: "SMILE_IDENTITY",
      },
    }))
  })

  describe("a client deleting their pending replacement ID", () => {
    const pendingReplacement = {
      ...document,
      id: "doc-1",
      docType: "ID_COPY",
      verified: false,
      verifiedAt: null,
      verifiedById: null,
    }
    const coreAfterDelete = [
      { id: "id-doc-1", docType: "ID_COPY", verified: true, verificationNote: null, contentSha256: "c".repeat(64), createdAt: new Date("2026-07-01T00:00:00.000Z") },
      { docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
      { docType: "PAYSLIP", verified: true, verificationNote: null },
      { docType: "BANK_STATEMENT", verified: true, verificationNote: null },
    ]

    beforeEach(() => {
      getDocumentCallerMock.mockResolvedValue({
        type: "client",
        clientId: "client-1",
        email: "client@example.test",
      })
      clientDocumentFindFirstMock.mockReset()
      clientDocumentFindFirstMock
        .mockResolvedValueOnce(pendingReplacement)
        .mockResolvedValueOnce(pendingReplacement)
        .mockResolvedValue(passingSelfieDocument)
      clientDocumentFindManyMock.mockResolvedValue(coreAfterDelete)
    })

    it("does not promote a PENDING client back to VERIFIED", async () => {
      clientFindUniqueMock.mockResolvedValue({
        ...biometricSubject,
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      })

      const response = await DELETE(
        new Request("https://staging.acme-lending.example/api/documents/doc-1", { method: "DELETE" }),
        ctx,
      )

      expect(response.status).toBe(200)
      expect(clientUpdateMock).not.toHaveBeenCalled()
      expect(auditCreateMock).toHaveBeenCalledTimes(1)
    })

    it("still lowers the stored status when the delete leaves the evidence incomplete", async () => {
      clientFindUniqueMock.mockResolvedValue({
        ...biometricSubject,
        kycStatus: "VERIFIED",
        kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
        kycVerifiedById: "officer-previous",
        kycVerificationMethod: "PHYSICAL",
      })
      clientDocumentFindManyMock.mockResolvedValue(coreAfterDelete.slice(0, 3))

      const response = await DELETE(
        new Request("https://staging.acme-lending.example/api/documents/doc-1", { method: "DELETE" }),
        ctx,
      )

      expect(response.status).toBe(200)
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ kycStatus: "PENDING" }),
      }))
    })
  })

  it("fails closed when the strict deletion audit cannot be written", async () => {
    auditCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", {
        method: "DELETE",
      }),
      ctx,
    )

    expect(response.status).toBe(500)
    expect(auditCreateMock).toHaveBeenCalledOnce()
    expect(deleteFileMock).not.toHaveBeenCalled()
  })

  it("refuses to delete a credit agreement for staff and retains its bytes", async () => {
    clientDocumentFindFirstMock.mockReset().mockResolvedValue({
      ...document,
      docType: "CREDIT_AGREEMENT",
      contentSha256: "a".repeat(64),
    })

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", {
        method: "DELETE",
      }),
      ctx,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Credit-agreement and statutory PASQ records are immutable and cannot be deleted",
    })
    expect(clientDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
    expect(deleteFileMock).not.toHaveBeenCalled()
  })

  it("refuses to delete a statutory PASQ for staff and retains its bytes", async () => {
    clientDocumentFindFirstMock.mockReset().mockResolvedValue({
      ...document,
      docType: "FORM_20_PRE_AGREEMENT",
      contentSha256: "a".repeat(64),
    })

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", {
        method: "DELETE",
      }),
      ctx,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Credit-agreement and statutory PASQ records are immutable and cannot be deleted",
    })
    expect(clientDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
    expect(deleteFileMock).not.toHaveBeenCalled()
  })

  it("rechecks credit-agreement immutability after taking the evidence lock", async () => {
    clientDocumentFindFirstMock.mockReset()
      .mockResolvedValueOnce(document)
      .mockResolvedValueOnce({ ...document, docType: "CREDIT_AGREEMENT" })

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", {
        method: "DELETE",
      }),
      ctx,
    )

    expect(response.status).toBe(409)
    expect(clientDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
    expect(deleteFileMock).not.toHaveBeenCalled()
  })

  // A PO funding application names its purchase order (LoanApplication.poDocumentId).
  it("refuses to delete a purchase order an application relies on, checked under the evidence lock", async () => {
    const po = { ...document, docType: "PO_DOCUMENT" }
    clientDocumentFindFirstMock.mockReset().mockResolvedValue(po)
    loanApplicationFindFirstMock.mockResolvedValue({ id: "app-po" })

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", { method: "DELETE" }),
      ctx,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "This purchase order is part of a PO funding application and cannot be deleted",
    })
    expect(loanApplicationFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      // A DECLINED or CANCELLED application no longer holds its order (erasure).
      where: { tenantId: "tenant-1", poDocumentId: "doc-1", status: { notIn: ["DECLINED", "CANCELLED"] } },
    }))
    // Asked after the evidence lock, like every other immutability check.
    expect(queryRawMock.mock.invocationCallOrder[0])
      .toBeLessThan(loanApplicationFindFirstMock.mock.invocationCallOrder[0])
    expect(clientDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(deleteFileMock).not.toHaveBeenCalled()
  })

  it("still deletes a purchase order no application names", async () => {
    const po = { ...document, docType: "PO_DOCUMENT", verified: false }
    clientDocumentFindFirstMock.mockReset().mockResolvedValue(po)
    loanApplicationFindFirstMock.mockResolvedValue(null)

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", { method: "DELETE" }),
      ctx,
    )

    expect(response.status).toBe(200)
    expect(clientDocumentUpdateManyMock).toHaveBeenCalled()
  })

  it("refuses to delete a proof of payment a pending payment notification relies on", async () => {
    clientDocumentFindFirstMock.mockReset().mockResolvedValue({ ...document, docType: "PROOF_OF_PAYMENT" })
    paymentNotificationFindFirstMock.mockResolvedValue({ id: "pn-1" })

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", { method: "DELETE" }),
      ctx,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "This proof of payment belongs to a payment notification awaiting reconciliation and cannot be deleted",
    })
    expect(paymentNotificationFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", documentId: "doc-1", status: "PENDING" },
    }))
    expect(queryRawMock.mock.invocationCallOrder[0])
      .toBeLessThan(paymentNotificationFindFirstMock.mock.invocationCallOrder[0])
    expect(clientDocumentUpdateManyMock).not.toHaveBeenCalled()
  })

  it("deletes a proof of payment once its notification is resolved", async () => {
    clientDocumentFindFirstMock.mockReset().mockResolvedValue({ ...document, docType: "PROOF_OF_PAYMENT", verified: false })
    paymentNotificationFindFirstMock.mockResolvedValue(null)

    const response = await DELETE(
      new Request("https://staging.acme-lending.example/api/documents/doc-1", { method: "DELETE" }),
      ctx,
    )

    expect(response.status).toBe(200)
    expect(clientDocumentUpdateManyMock).toHaveBeenCalled()
  })

  it("does not expose the unaudited generic verification PATCH to any staff role", () => {
    // Next.js returns 405 when a route module does not export the verb. All
    // verification now has to use the client-scoped CREDIT_OFFICER+ endpoint,
    // which also updates KYC and writes the mandatory audit row.
    expect(documentRoute).not.toHaveProperty("PATCH")
  })
})
