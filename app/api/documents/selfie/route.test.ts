import { beforeEach, describe, expect, it, vi } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"

const biometricSubject = {
  id: "client-1",
  idNumber: "9001015000086",
  firstName: "Synthetic",
  lastName: "Customer",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
}

const getDocumentCallerMock = vi.fn()
const outsideDocumentFindFirstMock = vi.fn()
const outsideClientFindUniqueMock = vi.fn()
const txDocumentFindFirstMock = vi.fn()
const txDocumentCreateMock = vi.fn()
const txDocumentUpdateManyMock = vi.fn()
const txDocumentFindManyMock = vi.fn()
const txClientFindUniqueMock = vi.fn()
const txClientUpdateMock = vi.fn()
const auditCreateMock = vi.fn()
const queryRawMock = vi.fn()
const transactionMock = vi.fn()
const saveFileMock = vi.fn()
const deleteFileMock = vi.fn()
const readFileMock = vi.fn()
const extractDocumentDataMock = vi.fn()

const tx = {
  $queryRaw: (query: unknown) => queryRawMock(query),
  clientDocument: {
    findFirst: (args: unknown) => txDocumentFindFirstMock(args),
    findMany: (args: unknown) => txDocumentFindManyMock(args),
    create: (args: unknown) => txDocumentCreateMock(args),
    updateMany: (args: unknown) => txDocumentUpdateManyMock(args),
  },
  client: {
    findUnique: (args: unknown) => txClientFindUniqueMock(args),
    update: (args: unknown) => txClientUpdateMock(args),
  },
  auditLog: { create: (args: unknown) => auditCreateMock(args) },
}

vi.mock("@/lib/document-auth", () => ({
  getDocumentCaller: () => getDocumentCallerMock(),
  MAGIC_BYTE_PREFIX: 12,
  matchesMagic: () => true,
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    callback: (tenant: { id: string }) => Promise<unknown>,
  ) => callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: {
      findFirst: (args: unknown) => outsideDocumentFindFirstMock(args),
    },
    client: {
      findUnique: (args: unknown) => outsideClientFindUniqueMock(args),
    },
    $transaction: (callback: (client: typeof tx) => Promise<unknown>) =>
      transactionMock(callback),
  },
}))
vi.mock("@/lib/storage", () => ({
  saveFile: (...args: unknown[]) => saveFileMock(...args),
  deleteFile: (...args: unknown[]) => deleteFileMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
}))
vi.mock("@/lib/vlm-extract", () => ({
  extractDocumentData: (...args: unknown[]) => extractDocumentDataMock(...args),
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_target, key) => String(key) }),
}))

import { POST } from "./route"

function request() {
  const form = new FormData()
  form.set("image", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "selfie.jpg", {
    type: "image/jpeg",
  }))
  form.set("clientId", "client-1")
  return new Request("https://staging.acme-lending.example/api/documents/selfie", {
    method: "POST",
    body: form,
  })
}

const verifiedCoreDocuments = [
  { id: "id-doc-1", docType: "ID_COPY", verified: true, verificationNote: null },
  { id: "poa-doc-1", docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
  { id: "pay-doc-1", docType: "PAYSLIP", verified: true, verificationNote: null },
  { id: "bank-doc-1", docType: "BANK_STATEMENT", verified: true, verificationNote: null },
]

const ID_DOCUMENT_ROW = {
  id: "id-doc-1",
  storagePath: "tenant-1/client-1/id.jpg",
  mimeType: "image/jpeg",
  contentSha256: "c".repeat(64),
}

function persistedSelfieFromLatestUpdate(id = "selfie-doc-1") {
  const lastUpdate = txDocumentUpdateManyMock.mock.calls.at(-1)?.[0] as
    | { data?: Record<string, unknown> }
    | undefined
  return {
    id,
    deletedAt: null,
    ...(lastUpdate?.data ?? {}),
  }
}

describe("POST /api/documents/selfie", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getDocumentCallerMock.mockResolvedValue({
      type: "staff",
      userId: "officer-1",
      role: "CREDIT_OFFICER",
      tenantId: "tenant-1",
    })
    outsideDocumentFindFirstMock.mockResolvedValue({ id: "id-doc-1" })
    outsideClientFindUniqueMock.mockResolvedValue({
      idNumber: "9001015000086",
      firstName: "Synthetic",
      lastName: "Customer",
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-21T09:00:00.000Z"),
    })
    txDocumentFindFirstMock
      .mockResolvedValueOnce(ID_DOCUMENT_ROW)
      .mockResolvedValueOnce({
        id: "selfie-doc-1",
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: null,
        extractionStatus: "processing",
        extractionGeneration: "generation-from-create",
      })
      .mockImplementation(() => Promise.resolve(persistedSelfieFromLatestUpdate()))
    txDocumentFindManyMock.mockResolvedValue(verifiedCoreDocuments)
    txDocumentCreateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "selfie-doc-1",
      ...data,
    }))
    txDocumentUpdateManyMock.mockResolvedValue({ count: 1 })
    txClientFindUniqueMock.mockResolvedValue({
      ...biometricSubject,
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
      updatedAt: new Date("2026-07-21T09:00:00.000Z"),
    })
    txClientUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
      updatedAt: new Date("2026-07-21T10:00:00.000Z"),
      ...data,
    }))
    auditCreateMock.mockResolvedValue({ id: "audit-1" })
    queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
    transactionMock.mockImplementation(
      (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    )
    saveFileMock.mockResolvedValue({
      storagePath: "tenant-1/client-1/selfie.jpg",
      fileSize: 4,
    })
    deleteFileMock.mockResolvedValue(undefined)
    readFileMock.mockResolvedValue(Buffer.from("id-document-bytes"))
    extractDocumentDataMock.mockResolvedValue({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: true },
        quality: { value: "good" },
        livenessConfidence: { value: 0.97 },
        idPhotoKind: { value: "photograph" },
        idPhotoIsRealPhotograph: { value: true },
        idPhotoFaceDetected: { value: true },
        selfieIsRealPhotograph: { value: true },
        samePerson: { value: "same" },
        faceMatch: { value: true },
        matchConfidence: { value: 0.95 },
      },
    })
  })

  it("claims a generation under the evidence lock and commits biometric KYC with one strict audit", async () => {
    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    const create = txDocumentCreateMock.mock.calls[0][0]
    const generation = create.data.extractionGeneration
    expect(create.data).toEqual(expect.objectContaining({
      extractionStatus: "processing",
      extractionGeneration: expect.stringMatching(/^[0-9a-f-]{36}$/),
      extractionStartedAt: expect.any(Date),
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      txDocumentCreateMock.mock.invocationCallOrder[0],
    )

    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentFindFirstMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        id: "selfie-doc-1",
        extractionStatus: "processing",
        extractionGeneration: generation,
        deletedAt: null,
        verified: false,
        verificationNote: null,
      }),
    }))
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ extractionGeneration: generation }),
      data: expect.objectContaining({
        extractionStatus: "done",
        extractionStartedAt: null,
        verified: true,
        validationMismatch: false,
        biometricMatchScore: 95,
        biometricLiveness: 97,
        verificationNote: "Automatically verified by VLM face match against the ID document photograph",
        biometricResult: expect.objectContaining({
          provider: "vlm-face-match-v1",
          verified: true,
          faceMatch: true,
          idDocumentId: "id-doc-1",
          idDocumentSha256: "c".repeat(64),
          subjectFingerprint: biometricSubjectFingerprint(biometricSubject),
        }),
      }),
    }))
    // The provider evidence must be REAL: two-image VLM face match against
    // the stored ID document bytes, never a simulated external provider.
    expect(readFileMock).toHaveBeenCalledWith("tenant-1/client-1/id.jpg")
    expect(extractDocumentDataMock).toHaveBeenCalledWith(expect.objectContaining({
      docType: "SELFIE",
      referenceImage: expect.objectContaining({ mimeType: "image/jpeg" }),
    }))
    const persistedBiometric = (txDocumentUpdateManyMock.mock.calls[0][0] as {
      data: { biometricResult: Record<string, unknown> }
    }).data.biometricResult
    expect(persistedBiometric).not.toHaveProperty("simulated")
    expect(txClientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: expect.any(Date),
        kycVerifiedById: null,
        kycVerificationMethod: "BIOMETRIC",
      },
    }))
    expect(auditCreateMock).toHaveBeenCalledTimes(2)
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({
        action: "KYC_APPROVED",
        entity: "ClientDocument",
        entityId: "selfie-doc-1",
        oldValue: expect.objectContaining({
          clientKyc: {
            kycStatus: "PENDING",
            kycVerifiedAt: null,
            kycVerifiedById: null,
            kycVerificationMethod: null,
          },
        }),
        newValue: expect.objectContaining({
          document: expect.objectContaining({
            extractionGeneration: generation,
            matchScore: 95,
            livenessScore: 97,
          }),
          clientKyc: expect.objectContaining({
            kycStatus: "VERIFIED",
            kycVerificationMethod: "BIOMETRIC",
          }),
        }),
      }),
    })
  })

  it("removes biometric bytes when the mandatory upload audit aborts the transaction", async () => {
    auditCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await POST(request() as never)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "Failed to upload selfie" })
    expect(txDocumentCreateMock).toHaveBeenCalledOnce()
    expect(auditCreateMock).toHaveBeenCalledOnce()
    expect(deleteFileMock).toHaveBeenCalledOnce()
    expect(deleteFileMock).toHaveBeenCalledWith("tenant-1/client-1/selfie.jpg")
    expect(extractDocumentDataMock).not.toHaveBeenCalled()
  })

  it("does not let a stale callback overwrite a later manual document decision", async () => {
    txDocumentFindFirstMock
      .mockReset()
      .mockResolvedValueOnce(ID_DOCUMENT_ROW)
      .mockResolvedValueOnce(null)

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentFindFirstMock).toHaveBeenCalledTimes(2))
    expect(txDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(txClientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).toHaveBeenCalledOnce()
  })

  it("fails closed when liveness is false and records the rejected outcome transactionally", async () => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: false },
        quality: { value: "good" },
      },
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        extractionStartedAt: null,
        verified: false,
        validationMismatch: true,
        biometricVerifiedAt: null,
        biometricMatchScore: null,
      }),
    }))
    expect(txClientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "FAILED",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({ action: "KYC_REJECTED" }),
    })
  })

  it("writes no provider evidence and does not verify KYC when VLM quality evidence is missing", async () => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: true },
      },
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        verified: false,
        biometricMatchScore: null,
      }),
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({
        action: "KYC_REJECTED",
        newValue: expect.objectContaining({
          document: expect.objectContaining({
            biometricFailureReason: "biometric_evidence_missing",
          }),
        }),
      }),
    })
  })

  it.each([
    ["uppercase unusable", "UNUSABLE", "image_unusable"],
    ["whitespace unusable", "  unusable  ", "image_unusable"],
    ["object quality", { label: "good" }, "biometric_evidence_missing"],
    ["unexpected quality", "excellent", "biometric_evidence_missing"],
  ] as const)("writes no provider evidence for %s VLM evidence", async (_label, quality, reason) => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: true },
        quality: { value: quality },
      },
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        verified: false,
        biometricMatchScore: null,
        biometricResult: expect.objectContaining({ biometricFailureReason: reason }),
      }),
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({
        action: "KYC_REJECTED",
        newValue: expect.objectContaining({
          document: expect.objectContaining({ biometricFailureReason: reason }),
        }),
      }),
    })
  })

  it("keeps client KYC pending when a valid selfie is missing a verified core document", async () => {
    // First findMany is the ID-binding persist gate; the SECOND is the
    // composite core-document read this test manipulates.
    txDocumentFindManyMock
      .mockResolvedValueOnce(verifiedCoreDocuments)
      .mockResolvedValueOnce(
        verifiedCoreDocuments.filter(({ docType }) => docType !== "PAYSLIP"),
      )

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txClientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({ action: "DOCUMENT_VERIFIED" }),
    })
  })

  it("downgrades KYC when the latest selfie attempt fails", async () => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: false },
        quality: { value: "good" },
      },
    })
    txClientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
      kycVerifiedById: "officer-old",
      kycVerificationMethod: "SMILE_IDENTITY",
      updatedAt: new Date("2026-07-21T09:00:00.000Z"),
    })
    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txClientUpdateMock).toHaveBeenCalledTimes(2))
    expect(txClientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "FAILED",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({
        action: "KYC_REJECTED",
        newValue: expect.objectContaining({
          document: expect.objectContaining({ latestSelfie: true }),
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

  it("does not let an older failed callback downgrade a newer selfie outcome", async () => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: false },
        quality: { value: "good" },
      },
    })
    txClientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
      kycVerifiedById: "officer-old",
      kycVerificationMethod: "SMILE_IDENTITY",
      updatedAt: new Date("2026-07-21T09:00:00.000Z"),
    })
    txDocumentFindFirstMock.mockReset()
      .mockResolvedValueOnce(ID_DOCUMENT_ROW)
      .mockResolvedValueOnce({
        id: "selfie-doc-1",
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: null,
        extractionStatus: "processing",
        extractionGeneration: "generation-from-create",
      })
      .mockResolvedValueOnce({ id: "newer-selfie-doc" })
      .mockResolvedValueOnce({ id: "newer-selfie-doc" })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentFindFirstMock.mock.calls[2][0]).toEqual(expect.objectContaining({
      where: expect.not.objectContaining({ deletedAt: null }),
    }))
    expect(txClientUpdateMock).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({
        newValue: expect.objectContaining({
          document: expect.objectContaining({
            latestSelfie: false,
            verified: false,
            biometricFailureReason: "vlm_liveness_failed",
          }),
        }),
      }),
    })
  })

  it("does not accept an older successful callback after a newer selfie attempt exists", async () => {
    txDocumentFindFirstMock.mockReset()
      .mockResolvedValueOnce(ID_DOCUMENT_ROW)
      .mockResolvedValueOnce({
        id: "selfie-doc-1",
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: null,
        extractionStatus: "processing",
        extractionGeneration: "generation-from-create",
      })
      .mockResolvedValueOnce({ id: "newer-selfie-doc" })
      .mockResolvedValueOnce({ id: "newer-selfie-doc" })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(extractDocumentDataMock).toHaveBeenCalledOnce()
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        extractionError: "Biometric attempt was superseded by a newer selfie",
        verified: false,
        validationMismatch: true,
        biometricResult: expect.objectContaining({
          biometricFailureReason: "superseded_biometric_evidence",
        }),
      }),
    }))
    expect(txClientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({
        action: "KYC_REJECTED",
        newValue: expect.objectContaining({
          document: expect.objectContaining({
            verified: false,
            latestSelfie: false,
            biometricFailureReason: "superseded_biometric_evidence",
          }),
        }),
      }),
    })
  })

  it("does not bind a provider result to client evidence that changed while the callback ran", async () => {
    txClientFindUniqueMock
      .mockResolvedValueOnce({
        ...biometricSubject,
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
        updatedAt: new Date("2026-07-21T09:00:00.000Z"),
      })
      // A REAL identity edit: the surname the selfie was bound to is no longer
      // the surname on file. The fingerprint — not the row timestamp — is what
      // must catch this.
      .mockResolvedValueOnce({
        ...biometricSubject,
        lastName: "Different",
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
        updatedAt: new Date("2026-07-21T09:00:00.000Z"),
      })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        extractionError: "Client evidence changed during biometric verification",
        verified: false,
        validationMismatch: true,
      }),
    }))
    expect(txClientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({
        action: "KYC_REJECTED",
        newValue: expect.objectContaining({
          document: expect.objectContaining({
            extractionError: "Client evidence changed during biometric verification",
            biometricFailureReason: "subject_identity_changed",
          }),
        }),
      }),
    })
  })

  // Regression: `Client.updatedAt` bumps on ANY write to the row, and the VLM
  // call sits in that window for tens of seconds. Binding by timestamp failed
  // biometrically valid attempts — reported as `subject_identity_changed` —
  // whenever an unrelated write landed, including writes this pipeline makes
  // itself (KYC reopen, composite-KYC recompute, verifying another document).
  it("verifies an attempt when an unrelated write bumped the client row mid-callback", async () => {
    txClientFindUniqueMock
      .mockResolvedValueOnce({
        ...biometricSubject,
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
        updatedAt: new Date("2026-07-21T09:00:00.000Z"),
      })
      // Same person, every identity field byte-identical — only the row
      // timestamp moved.
      .mockResolvedValueOnce({
        ...biometricSubject,
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
        updatedAt: new Date("2026-07-21T09:01:00.000Z"),
      })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "done",
        extractionError: null,
        verified: true,
        validationMismatch: false,
        biometricResult: expect.objectContaining({
          verified: true,
          faceMatch: true,
          biometricFailureReason: null,
          subjectFingerprint: biometricSubjectFingerprint(biometricSubject),
        }),
      }),
    }))
  })

  it("does not overwrite a manual KYC rejection that predates the provider callback", async () => {
    outsideClientFindUniqueMock.mockResolvedValueOnce({
      idNumber: "9001015000086",
      firstName: "Synthetic",
      lastName: "Customer",
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-21T09:02:00.000Z"),
    })
    txClientFindUniqueMock
      .mockResolvedValueOnce({
        ...biometricSubject,
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
        kycManualRejectionActive: false,
        updatedAt: new Date("2026-07-21T09:02:00.000Z"),
      })
      .mockResolvedValueOnce({
        ...biometricSubject,
        kycStatus: "FAILED",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
        kycManualRejectionActive: true,
        kycManualRejectionAt: new Date("2026-07-21T09:03:00.000Z"),
        kycManualRejectionById: "compliance-1",
        kycManualRejectionReason: "Identity evidence requires investigation",
        updatedAt: new Date("2026-07-21T09:02:00.000Z"),
      })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        verified: true,
        validationMismatch: false,
        extractionError: null,
      }),
    }))
    expect(txClientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "FAILED",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({
        action: "DOCUMENT_VERIFIED",
        newValue: expect.objectContaining({
          document: expect.objectContaining({
            biometricFailureReason: null,
          }),
          clientKyc: expect.objectContaining({ kycStatus: "FAILED" }),
        }),
      }),
    })
  })

  it("reopens a failed prior attempt and lets a newer valid selfie recover KYC", async () => {
    txClientFindUniqueMock
      .mockResolvedValueOnce({
        ...biometricSubject,
        kycStatus: "FAILED",
        kycVerifiedAt: null,
        kycVerifiedById: "officer-rejected",
        kycVerificationMethod: "PHYSICAL",
        updatedAt: new Date("2026-07-21T08:59:00.000Z"),
      })
      .mockResolvedValueOnce({
        ...biometricSubject,
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
        updatedAt: new Date("2026-07-21T09:00:00.000Z"),
      })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txClientUpdateMock).toHaveBeenCalledTimes(2))
    expect(txClientUpdateMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      data: {
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    }))
    expect(txClientUpdateMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: expect.any(Date),
        kycVerifiedById: null,
        kycVerificationMethod: "BIOMETRIC",
      },
    }))
    expect(auditCreateMock.mock.calls[0][0]).toEqual({
      data: expect.objectContaining({
        oldValue: {
          clientKyc: expect.objectContaining({ kycStatus: "FAILED" }),
        },
        newValue: expect.objectContaining({
          biometricAttempt: expect.objectContaining({
            reason: "new_biometric_attempt",
            clientKyc: expect.objectContaining({ kycStatus: "PENDING" }),
          }),
        }),
      }),
    })
  })

  it("rejects the attempt when the VLM face match does not confirm the ID photograph", async () => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: true },
        quality: { value: "good" },
        livenessConfidence: { value: 0.95 },
        idPhotoKind: { value: "photograph" },
        idPhotoIsRealPhotograph: { value: true },
        idPhotoFaceDetected: { value: true },
        selfieIsRealPhotograph: { value: true },
        samePerson: { value: "different" },
        faceMatch: { value: false },
        matchConfidence: { value: 0.1 },
      },
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        verified: false,
        validationMismatch: true,
        biometricVerifiedAt: null,
        biometricMatchScore: 10,
        biometricResult: expect.objectContaining({
          provider: "vlm-face-match-v1",
          verified: false,
          faceMatch: false,
          biometricFailureReason: "match_score_below_threshold",
        }),
      }),
    }))
    expect(txClientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({ action: "KYC_REJECTED" }),
    })
  })

  // 2026-10-10: the VLM said faceMatch=true at 0.85 against an ID card whose
  // portrait box held only a grey silhouette. The model's own optimistic
  // booleans must not carry the match once it classifies the portrait as a
  // placeholder.
  it("rejects a confident match against a silhouette placeholder ID portrait", async () => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: true },
        quality: { value: "good" },
        livenessConfidence: { value: 0.95 },
        idPhotoKind: { value: "silhouette_placeholder" },
        idPhotoIsRealPhotograph: { value: true },
        idPhotoFaceDetected: { value: true },
        selfieIsRealPhotograph: { value: true },
        samePerson: { value: "same" },
        faceMatch: { value: true },
        matchConfidence: { value: 0.85 },
      },
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        verified: false,
        validationMismatch: true,
        biometricVerifiedAt: null,
        biometricResult: expect.objectContaining({
          provider: "vlm-face-match-v1",
          verified: false,
          idPhotoKind: "silhouette_placeholder",
          error: "ID document portrait is not a photograph (silhouette_placeholder)",
          biometricFailureReason: "provider_verification_failed",
        }),
      }),
    }))
    expect(txClientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({ action: "KYC_REJECTED" }),
    })
  })

  it("writes no provider evidence when the VLM response lacks the face-match verdict", async () => {
    // A legacy single-image response (liveness only). Without a complete
    // verdict there is no provider evidence at all — never a partial pass.
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: true },
        quality: { value: "good" },
      },
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        verified: false,
        biometricMatchScore: null,
        biometricVerifiedAt: null,
      }),
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({ action: "KYC_REJECTED" }),
    })
  })

  it("does not bind provider evidence to an ID document replaced during the callback", async () => {
    // The persist gate re-reads the CURRENT ID document inside the money
    // transaction; the evidence names id-doc-1, but a newer ID landed.
    txDocumentFindManyMock.mockResolvedValueOnce([{ id: "id-doc-REPLACED" }])

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        verified: false,
        biometricVerifiedAt: null,
        biometricResult: expect.objectContaining({
          biometricFailureReason: "subject_identity_changed",
        }),
      }),
    }))
  })

    it("fails the attempt without calling the VLM when the stored ID bytes are unavailable", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"))

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(extractDocumentDataMock).not.toHaveBeenCalled()
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        verified: false,
        extractionError: "Stored ID document bytes are unavailable for the face match",
      }),
    }))
  })
})
