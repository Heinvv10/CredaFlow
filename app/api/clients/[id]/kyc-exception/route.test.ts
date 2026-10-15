import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { PASSING_FACE_MODEL_EVIDENCE } from "@/lib/kyc/face-model/evidence.test-helpers"

const requireApiRoleMock = vi.fn()
const transactionMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const clientUpdateMock = vi.fn()
const documentFindManyMock = vi.fn()
const documentFindFirstMock = vi.fn()
const complianceFindFirstMock = vi.fn()
const complianceCreateMock = vi.fn()
const auditCreateMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()

const tx = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  tenantConfig: { findUnique: (...args: unknown[]) => tenantConfigFindUniqueMock(...args) },
  client: {
    findUnique: (...args: unknown[]) => clientFindUniqueMock(...args),
    update: (...args: unknown[]) => clientUpdateMock(...args),
  },
  clientDocument: {
    findMany: (...args: unknown[]) => documentFindManyMock(...args),
    findFirst: (...args: unknown[]) => documentFindFirstMock(...args),
  },
  complianceRecord: {
    findFirst: (...args: unknown[]) => complianceFindFirstMock(...args),
    create: (...args: unknown[]) => complianceCreateMock(...args),
  },
  auditLog: {
    create: (...args: unknown[]) => auditCreateMock(...args),
  },
}

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    callback: (tenant: { id: string }) => Promise<unknown>,
  ) => callback({ id: "tenant-1" }),
}))
const DATABASE_NOW = new Date("2026-10-14T10:00:00.123Z")
vi.mock("@/lib/db-clock", () => ({ databaseNow: async () => DATABASE_NOW }))
vi.mock("@/lib/affordability/evidence-locks", () => ({
  lockAffordabilityClientEvidence: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (
      callback: (client: typeof tx) => Promise<unknown>,
      options: unknown,
    ) => transactionMock(callback, options),
  },
}))

import { POST } from "./route"

const client = {
  id: "client-1",
  idNumber: "9912310000085",
  firstName: "Synthetic",
  lastName: "Customer",
  dateOfBirth: new Date("1999-12-31T00:00:00.000Z"),
  kycStatus: "FAILED",
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
}
const verifiedCore = [
  "ID_COPY",
  "PROOF_OF_ADDRESS",
  "PAYSLIP",
  "BANK_STATEMENT",
].map((docType) => ({ docType, verified: true, verificationNote: null }))
const selfie = {
  id: "selfie-1",
  contentSha256: "a".repeat(64),
  deletedAt: null,
  verified: false,
  extractionStatus: "failed",
  extractionResult: null,
  extractionError: "Biometric verification did not run",
  validationMismatch: true,
  validationScore: 0,
  biometricMatchScore: null,
  biometricLiveness: null,
  biometricVerifiedAt: null,
  biometricResult: { biometricFailureReason: "face_not_detected" },
}

function request(body: Record<string, unknown>) {
  return new NextRequest(
    "https://staging.example.test/api/clients/client-1/kyc-exception",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )
}

const params = { params: Promise.resolve({ id: "client-1" }) }

describe("POST /api/clients/[id]/kyc-exception", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({
      user: {
        id: "admin-1",
        email: "admin@example.test",
        role: "ADMIN",
        totpVerified: true,
      },
    })
    transactionMock.mockImplementation(
      (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    )
    clientFindUniqueMock.mockResolvedValue(client)
    documentFindManyMock.mockResolvedValue(verifiedCore)
    documentFindFirstMock.mockResolvedValue(selfie)
    complianceFindFirstMock.mockResolvedValue(null)
    complianceCreateMock.mockResolvedValue({ id: "exception-1" })
    clientUpdateMock.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data,
    )
    auditCreateMock.mockResolvedValue({ id: "audit-1" })
    tenantConfigFindUniqueMock.mockResolvedValue({
      kycOverrideEnabled: true,
      kycOverrideMinRole: "ADMIN",
      kycOverrideSecondApprover: false,
      requireStaffTotp: true,
    })
  })

  it("refuses while a replacement ID copy awaits review, writing nothing", async () => {
    documentFindManyMock.mockResolvedValue([
      ...verifiedCore.map((document) => ({
        ...document, id: `doc-${document.docType}`, createdAt: new Date("2026-07-01T00:00:00.000Z"),
      })),
      {
        id: "id-replacement", docType: "ID_COPY", verified: false, verificationNote: null,
        createdAt: new Date("2026-07-02T00:00:00.000Z"),
        verificationRejectedAt: null, verificationRejectedById: null,
      },
    ])

    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence:
        "ID copy and physical comparison were reviewed against the customer.",
    }), params)

    expect(response.status).toBe(422)
    expect((await response.json()).missingDocs).toEqual(["ID_COPY"])
    expect(complianceCreateMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("requires ADMIN authority and atomically records an exact failed-attempt exception", async () => {
    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence:
        "ID copy and physical comparison were reviewed against the customer.",
    }), params)

    expect(response.status).toBe(201)
    expect(requireApiRoleMock).toHaveBeenCalledWith("BRANCH_MANAGER")
    expect(complianceCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        type: "KYC_EXCEPTION",
        referenceId: "client-1",
        status: "COMPLETED",
        // The database clock, not the host's.
        completedAt: DATABASE_NOW,
        data: expect.objectContaining({
          approvedAt: DATABASE_NOW.toISOString(),
          documentId: "selfie-1",
          documentSha256: "a".repeat(64),
          biometricFailureReason: "face_not_detected",
          approvedById: "admin-1",
        }),
      }),
      select: { id: true },
    })
    expect(clientUpdateMock).toHaveBeenCalledWith({
      where: { id: "client-1", tenantId: "tenant-1" },
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: expect.any(Date),
        kycVerifiedById: "admin-1",
        kycVerificationMethod: "PHYSICAL",
      },
      select: {
        kycStatus: true,
        kycVerifiedAt: true,
        kycVerifiedById: true,
        kycVerificationMethod: true,
      },
    })
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "KYC_EXCEPTION_GRANTED",
        entity: "Client",
        entityId: "client-1",
        newValue: expect.objectContaining({
          manualException: true,
          biometricVerified: false,
          exceptionRecordId: "exception-1",
        }),
      }),
    })
  })

  it("will not except a passed selfie matched against an ID copy that is no longer the verified one", async () => {
    const { biometricSubjectFingerprint } = await import("@/lib/kyc/biometric-evidence")
    const passedSelfie = {
      ...selfie,
      verified: true,
      extractionStatus: "done",
      extractionResult: {
        faceDetected: { value: true }, facesCount: { value: 1 }, isLive: { value: true }, quality: { value: "good" },
      },
      extractionError: null,
      validationMismatch: false,
      validationScore: 95,
      biometricMatchScore: 95,
      biometricLiveness: 97,
      biometricVerifiedAt: new Date("2026-10-11T08:00:00.000Z"),
      biometricResult: {
        ok: true, verified: true, provider: "vlm-face-match-v3", matchScore: 95, livenessScore: 97,
        faceModel: PASSING_FACE_MODEL_EVIDENCE,
        idPhotoKind: "photograph", idPhotoIsRealPhotograph: true, idPhotoFaceDetected: true,
        selfieIsRealPhotograph: true, samePerson: "same", faceMatch: true,
        matchConfidence: 0.95, livenessConfidence: 0.97,
        idDocumentId: "id-doc-1", idDocumentSha256: "c".repeat(64),
        subjectFingerprint: biometricSubjectFingerprint(client),
      },
    }
    documentFindFirstMock.mockImplementation(async (args: { where: { docType: string } }) => (
      args.where.docType === "ID_COPY" ? { id: "id-doc-2", contentSha256: "d".repeat(64) } : passedSelfie
    ))

    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence: "ID copy and physical comparison were reviewed against the customer.",
    }), params)

    expect(response.status).toBe(422)
    expect((await response.json()).biometricEvidence).toBe("subject_identity_changed")
    expect(documentFindFirstMock).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", clientId: "client-1", docType: "ID_COPY", deletedAt: null, verified: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, contentSha256: true },
    })
    expect(complianceCreateMock).not.toHaveBeenCalled()
  })

  it("requires a reason and supporting evidence before touching KYC state", async () => {
    const response = await POST(request({
      reason: "too short",
      supportingEvidence: "also short",
    }), params)

    expect(response.status).toBe(400)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("counts Unicode code points consistently with the database guard", async () => {
    const response = await POST(request({
      reason: "😀".repeat(10),
      supportingEvidence:
        "ID copy and physical comparison were reviewed against the customer.",
    }), params)

    expect(response.status).toBe(400)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it.each(["\t", "\n", "\u00a0", "\u2003"])(
    "rejects reasonless evidence made from %s edge whitespace",
    async (whitespace) => {
      const response = await POST(request({
        reason: whitespace.repeat(20),
        supportingEvidence:
          "ID copy and physical comparison were reviewed against the customer.",
      }), params)

      expect(response.status).toBe(400)
      expect(transactionMock).not.toHaveBeenCalled()
    },
  )

  it("rejects a legacy selfie whose bytes were not hash-bound", async () => {
    documentFindFirstMock.mockResolvedValue({
      ...selfie,
      contentSha256: null,
    })

    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence:
        "ID copy and physical comparison were reviewed against the customer.",
    }), params)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error:
        "The latest failed selfie is missing intact SHA-256-bound bytes. Capture a new selfie before exception review.",
    })
    expect(complianceCreateMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it.each([
    ["provider evidence is missing", {
      extractionStatus: "failed",
      biometricResult: {
        biometricFailureReason: "provider_verification_missing",
      },
    }],
    ["the evidence is not a terminal failed attempt", {
      extractionStatus: "done",
      biometricResult: {
        biometricFailureReason: "face_not_detected",
      },
    }],
  ])("fails closed when %s", async (_label, selfieChanges) => {
    documentFindFirstMock.mockResolvedValue({
      ...selfie,
      ...selfieChanges,
    })

    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence:
        "ID copy and physical comparison were reviewed against the customer.",
    }), params)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error:
        "This biometric failure cannot be overridden. Capture a new selfie against the current identity.",
      biometricEvidence: expect.any(String),
    })
    expect(complianceCreateMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("returns the role guard before parsing or mutating", async () => {
    requireApiRoleMock.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })

    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence:
        "ID copy and physical comparison were reviewed against the customer.",
    }), params)

    expect(response.status).toBe(403)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("refuses a caller below the lender's configured minimum role", async () => {
    requireApiRoleMock.mockResolvedValue({ user: { id: "manager-1", email: "manager@test.invalid", role: "BRANCH_MANAGER", totpVerified: true } })
    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence: "ID copy and physical comparison were reviewed against the customer.",
    }), params)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe("role_below_policy")
    expect(complianceCreateMock).not.toHaveBeenCalled()
  })

  it("requires TOTP only when the lender requires staff TOTP", async () => {
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@test.invalid", role: "ADMIN", totpVerified: false } })
    let response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence: "ID copy and physical comparison were reviewed against the customer.",
    }), params)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe("totp_required")

    tenantConfigFindUniqueMock.mockResolvedValue({
      kycOverrideEnabled: true, kycOverrideMinRole: "ADMIN",
      kycOverrideSecondApprover: false, requireStaffTotp: false,
    })
    response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence: "ID copy and physical comparison were reviewed against the customer.",
    }), params)
    expect(response.status).toBe(201)
  })

  it("requires the request workflow when second approval is enabled", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({
      kycOverrideEnabled: true, kycOverrideMinRole: "ADMIN",
      kycOverrideSecondApprover: true, requireStaffTotp: true,
    })
    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence: "ID copy and physical comparison were reviewed against the customer.",
    }), params)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe("second_approver_required")
  })

  it("refuses disabled overrides", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({
      kycOverrideEnabled: false, kycOverrideMinRole: "ADMIN",
      kycOverrideSecondApprover: false, requireStaffTotp: true,
    })
    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence: "ID copy and physical comparison were reviewed against the customer.",
    }), params)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe("overrides_disabled")
  })

  it.each([
    [0.29, "uncertain"],
    [0.33, "different"],
  ] as const)("refuses a clear mismatch at similarity %s / verdict %s", async (similarity, samePerson) => {
    documentFindFirstMock.mockResolvedValue({
      ...selfie,
      biometricResult: {
        biometricFailureReason: "match_score_below_threshold",
        faceModel: { similarity },
        faceVerdict: { samePerson },
      },
    })
    const response = await POST(request({
      reason: "Senior reviewer accepted the physical identity evidence.",
      supportingEvidence: "ID copy and physical comparison were reviewed against the customer.",
    }), params)
    expect(response.status).toBe(422)
    expect((await response.json()).code).toBe("clear_mismatch")
    expect(complianceCreateMock).not.toHaveBeenCalled()
  })
})
