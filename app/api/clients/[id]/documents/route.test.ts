import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  getDocumentCaller: vi.fn(),
  clientFindFirst: vi.fn(),
  documentFindMany: vi.fn(),
  documentFindFirst: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock("@/lib/document-auth", () => ({
  getDocumentCaller: mocks.getDocumentCaller,
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: vi.fn().mockImplementation(
    (
      _req: NextRequest,
      callback: (tenant: { id: string }) => unknown,
    ) => callback({ id: "tenant-portal" }),
  ),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    client: { findFirst: mocks.clientFindFirst },
    clientDocument: {
      findMany: mocks.documentFindMany,
      findFirst: mocks.documentFindFirst,
    },
  },
}))

import { GET } from "./route"

const coreTypes = [
  "ID_COPY",
  "PROOF_OF_ADDRESS",
  "PAYSLIP",
  "BANK_STATEMENT",
] as const

function request(includeKycChecklist = false) {
  return new NextRequest(
    `https://staging.acme-lending.example/api/clients/client-portal/documents${
      includeKycChecklist ? "?includeKycChecklist=1" : ""
    }`,
  )
}

const params = { params: Promise.resolve({ id: "client-portal" }) }

describe("GET /api/clients/[id]/documents", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(
      (
        callback: (tx: {
          client: { findFirst: typeof mocks.clientFindFirst }
          clientDocument: {
            findMany: typeof mocks.documentFindMany
            findFirst: typeof mocks.documentFindFirst
          }
        }) => unknown,
      ) => callback({
        client: { findFirst: mocks.clientFindFirst },
        clientDocument: {
          findMany: mocks.documentFindMany,
          findFirst: mocks.documentFindFirst,
        },
      }),
    )
    mocks.getDocumentCaller.mockResolvedValue({
      type: "client",
      clientId: "client-portal",
    })
    const coreDocuments = coreTypes.map((docType) => ({
      id: `doc-${docType}`,
      tenantId: "tenant-portal",
      clientId: "client-portal",
      docType,
      verified: false,
      verificationNote: null,
      validationMismatch: false,
      storagePath: `private/${docType}`,
      createdAt: new Date("2026-07-23T03:00:00.000Z"),
    }))
    const selfie = {
      id: "selfie-current",
      tenantId: "tenant-portal",
      clientId: "client-portal",
      docType: "SELFIE",
      deletedAt: null,
      verified: false,
      extractionStatus: "processing",
      extractionResult: null,
      extractionError: null,
      validationMismatch: false,
      validationScore: null,
      biometricMatchScore: null,
      biometricLiveness: null,
      biometricVerifiedAt: null,
      biometricResult: null,
      storagePath: "private/selfie",
      createdAt: new Date("2026-07-23T03:01:00.000Z"),
    }
    mocks.clientFindFirst.mockResolvedValue({
      id: "client-portal",
      idNumber: "9001015000086",
      firstName: "Synthetic",
      lastName: "Portal",
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      popiaConsentGiven: true,
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
      kycManualRejectionActive: false,
      kycManualRejectionAt: null,
      kycManualRejectionById: null,
      kycManualRejectionReason: null,
      kycManualRejectionResolvedAt: null,
      kycManualRejectionResolvedById: null,
      kycManualRejectionResolutionReason: null,
      documents: [selfie, ...coreDocuments],
    })
    mocks.documentFindMany.mockImplementation(
      async (args: { where: { docType?: unknown } }) =>
        args.where.docType
          ? coreDocuments.map(({ docType, verified, verificationNote }) => ({
              docType,
              verified,
              verificationNote,
            }))
          : [selfie, ...coreDocuments],
    )
    mocks.documentFindFirst.mockResolvedValue(selfie)
  })

  it("rejects an unauthenticated caller before document access", async () => {
    mocks.getDocumentCaller.mockResolvedValue(null)

    const response = await GET(request(true), params)

    expect(response.status).toBe(401)
    expect(mocks.documentFindMany).not.toHaveBeenCalled()
    expect(mocks.clientFindFirst).not.toHaveBeenCalled()
  })

  it("rejects a portal caller requesting another client's checklist", async () => {
    mocks.getDocumentCaller.mockResolvedValue({
      type: "client",
      clientId: "different-client",
    })

    const response = await GET(request(true), params)

    expect(response.status).toBe(403)
    expect(mocks.documentFindMany).not.toHaveBeenCalled()
    expect(mocks.clientFindFirst).not.toHaveBeenCalled()
  })

  it("returns the shared composite checklist without leaking storage paths", async () => {
    const response = await GET(request(true), params)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.documents).toHaveLength(5)
    expect(body.documents.every(
      (document: Record<string, unknown>) => !("storagePath" in document),
    )).toBe(true)
    expect(body.kycChecklist).toMatchObject({
      complete: false,
      customerActionCount: 0,
      pendingReviewCount: 5,
      latestSelfieId: "selfie-current",
      selfie: {
        documentId: "selfie-current",
        status: "pending_review",
        reason: "extraction_incomplete",
      },
    })
    expect(mocks.clientFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "client-portal", tenantId: "tenant-portal" },
    }))
    expect(mocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "RepeatableRead" },
    )
  })

  it("preserves the existing array response when the checklist is not requested", async () => {
    const response = await GET(request(), params)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(5)
    expect(mocks.clientFindFirst).not.toHaveBeenCalled()
    expect(mocks.documentFindFirst).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
