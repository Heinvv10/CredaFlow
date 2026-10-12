import { beforeEach, describe, expect, it, vi } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { isManualKycExceptionableFailureReason } from "@/lib/kyc/manual-exception-policy"

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
  { id: "id-doc-1", docType: "ID_COPY", verified: true, verificationNote: null, contentSha256: "c".repeat(64) },
  { id: "poa-doc-1", docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
  { id: "pay-doc-1", docType: "PAYSLIP", verified: true, verificationNote: null },
  { id: "bank-doc-1", docType: "BANK_STATEMENT", verified: true, verificationNote: null },
]

// Every side judged a real photograph: a fixture that tests a selfie-quality
// reason must not also leave the portrait unjudged, which refuses first.
const JUDGED_REAL_PHOTOS = {
  idPhotoKind: { value: "photograph" },
  idPhotoIsRealPhotograph: { value: true },
  idPhotoFaceDetected: { value: true },
  selfieIsRealPhotograph: { value: true },
}

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
    outsideDocumentFindFirstMock.mockResolvedValue({ id: "id-doc-1", contentSha256: "c".repeat(64) })
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
          provider: "vlm-face-match-v2",
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
        ...JUDGED_REAL_PHOTOS,
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
        ...JUDGED_REAL_PHOTOS,
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
        ...JUDGED_REAL_PHOTOS,
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
          provider: "vlm-face-match-v2",
          verified: false,
          faceMatch: false,
          // The verdict's own refusal (not the score gate) names the reason.
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

  // 2026-10-10: the VLM said faceMatch=true at 0.85 against an ID card whose
  // portrait box held only a grey silhouette. The model's own optimistic
  // booleans must not carry the match once it classifies the portrait as a
  // placeholder — and the refusal must be recorded under a reason that is NOT
  // on the manual-exception allow-list, with the specific message persisted.
  it.each([
    [
      "a silhouette placeholder ID portrait",
      { idPhotoKind: { value: "silhouette_placeholder" } },
      { idPhotoKind: "silhouette_placeholder", selfieIsRealPhotograph: true },
      "id_document_portrait_invalid",
      "ID document portrait is not a photograph (silhouette_placeholder)",
    ],
    [
      "a selfie that is not a real photograph",
      { selfieIsRealPhotograph: { value: false } },
      { idPhotoKind: "photograph", selfieIsRealPhotograph: false },
      "selfie_not_real_photograph",
      "Selfie is not a real photograph of a live person",
    ],
  ])("rejects a confident match against %s", async (_label, change, judged, reason, message) => {
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
        samePerson: { value: "same" },
        faceMatch: { value: true },
        matchConfidence: { value: 0.85 },
        ...change,
      },
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        extractionError: message,
        verificationNote: message,
        verified: false,
        validationMismatch: true,
        biometricVerifiedAt: null,
        biometricResult: expect.objectContaining({
          provider: "vlm-face-match-v2",
          verified: false,
          error: message,
          biometricFailureReason: reason,
        }),
      }),
    }))
    expect(isManualKycExceptionableFailureReason(reason)).toBe(false)
    expect(txClientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
    const audit = auditCreateMock.mock.calls[1][0] as {
      data: { action: string; newValue: { document: Record<string, unknown> } }
    }
    expect(audit.data.action).toBe("KYC_REJECTED")
    expect(audit.data.newValue.document).toEqual(expect.objectContaining({
      extractionError: message,
      biometricFailureReason: reason,
      matchScore: 85,
      livenessScore: 95,
      faceMatchVerdict: {
        provider: "vlm-face-match-v2",
        rejection: message,
        idPhotoKind: judged.idPhotoKind,
        idPhotoIsRealPhotograph: true,
        idPhotoFaceDetected: true,
        selfieIsRealPhotograph: judged.selfieIsRealPhotograph,
        samePerson: "same",
        faceMatch: true,
        matchConfidence: 0.85,
        livenessConfidence: 0.95,
      },
    }))
  })

  // A selfie-side failure (liveness, face count) used to stop the pipeline
  // before the ID-side verdict was read, so a silhouette ID was recorded under
  // an exceptionable selfie reason. The strictest reason must win.
  it.each([
    ["liveness failed", "id_document_portrait_invalid", { isLive: { value: false } },
      { idPhotoKind: { value: "silhouette_placeholder" }, idPhotoIsRealPhotograph: { value: false }, idPhotoFaceDetected: { value: false } },
      "ID document portrait is not a photograph (silhouette_placeholder)"],
    ["two faces", "id_document_portrait_invalid", { facesCount: { value: 2 } },
      { idPhotoKind: { value: "silhouette_placeholder" }, idPhotoIsRealPhotograph: { value: false }, idPhotoFaceDetected: { value: false } },
      "ID document portrait is not a photograph (silhouette_placeholder)"],
    ["liveness failed", "selfie_not_real_photograph", { isLive: { value: false } },
      { selfieIsRealPhotograph: { value: false } },
      "Selfie is not a real photograph of a live person"],
    ["two faces", "selfie_not_real_photograph", { facesCount: { value: 2 } },
      { selfieIsRealPhotograph: { value: false } },
      "Selfie is not a real photograph of a live person"],
  ])("records %s against a refused portrait as the non-exceptionable %s", async (
    _label, reason, selfieSide, verdictSide, message,
  ) => {
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
        ...selfieSide,
        ...verdictSide,
      },
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    const update = txDocumentUpdateManyMock.mock.calls[0][0] as {
      data: {
        extractionStatus: string
        extractionError: string
        verified: boolean
        biometricResult: { biometricFailureReason: string }
      }
    }
    expect(update.data.extractionStatus).toBe("failed")
    expect(update.data.extractionError).toBe(message)
    expect(update.data.verified).toBe(false)
    expect(update.data.biometricResult.biometricFailureReason).toBe(reason)
    expect(isManualKycExceptionableFailureReason(update.data.biometricResult.biometricFailureReason)).toBe(false)
  })

  it("keeps the selfie-side reason when the verdict refusal is itself exceptionable", async () => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: false },
        quality: { value: "good" },
        livenessConfidence: { value: 0.2 },
        idPhotoKind: { value: "photograph" },
        idPhotoIsRealPhotograph: { value: true },
        idPhotoFaceDetected: { value: true },
        selfieIsRealPhotograph: { value: true },
        samePerson: { value: "different" },
        faceMatch: { value: false },
        matchConfidence: { value: 0.1 },
      },
    })

    await POST(request() as never)

    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        biometricResult: expect.objectContaining({ biometricFailureReason: "vlm_liveness_failed" }),
      }),
    }))
  })

  // One malformed field unrelated to the portrait made the whole verdict
  // unreadable, and a silhouette ID was again recorded under the selfie-side
  // reason. The side judgements must be read on their own.
  const silhouetteId = {
    idPhotoKind: { value: "silhouette_placeholder" },
    idPhotoIsRealPhotograph: { value: false },
    idPhotoFaceDetected: { value: false },
  }
  const verdictBase = {
    faceDetected: { value: true },
    facesCount: { value: 1 },
    isLive: { value: true },
    quality: { value: "good" },
    livenessConfidence: { value: 0.95 },
    selfieIsRealPhotograph: { value: true },
    samePerson: { value: "different" },
    faceMatch: { value: false },
    matchConfidence: { value: 0.1 },
  }
  const malformations: Array<[string, Record<string, unknown>]> = [
    ["matchConfidence missing", { matchConfidence: undefined }],
    ["livenessConfidence missing", { livenessConfidence: undefined }],
    ["samePerson missing", { samePerson: undefined }],
    ["matchConfidence 10", { matchConfidence: { value: 10 } }],
    ["idPhotoKind 'Silhouette Placeholder'", { idPhotoKind: { value: "Silhouette Placeholder" } }],
    ["idPhotoKind 'grey_avatar'", { idPhotoKind: { value: "grey_avatar" } }],
  ]
  const selfieFailures: Array<[string, Record<string, unknown>]> = [
    ["isLive false", { isLive: { value: false } }],
    ["facesCount 2", { facesCount: { value: 2 } }],
  ]
  it.each(selfieFailures.flatMap(([selfieLabel, selfieSide]) =>
    malformations.map(([malformedLabel, malformed]) =>
      [selfieLabel, malformedLabel, { ...verdictBase, ...silhouetteId, ...selfieSide, ...malformed }] as const)))(
    "records a silhouette ID with %s and %s as id_document_portrait_invalid",
    async (_selfieLabel, _malformedLabel, data) => {
      extractDocumentDataMock.mockResolvedValueOnce({ ok: true, data })

      await POST(request() as never)

      await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
      const update = txDocumentUpdateManyMock.mock.calls[0][0] as {
        data: { verified: boolean; biometricResult: { biometricFailureReason: string } }
      }
      expect(update.data.verified).toBe(false)
      expect(update.data.biometricResult.biometricFailureReason).toBe("id_document_portrait_invalid")
      expect(isManualKycExceptionableFailureReason(update.data.biometricResult.biometricFailureReason)).toBe(false)
    },
  )

  it("does not upgrade a real photo pair with a malformed confidence to a non-exceptionable reason", async () => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: {
        ...verdictBase,
        idPhotoKind: { value: "photograph" },
        idPhotoIsRealPhotograph: { value: true },
        idPhotoFaceDetected: { value: true },
        isLive: { value: false },
        matchConfidence: { value: 10 },
      },
    })

    await POST(request() as never)

    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        biometricResult: expect.objectContaining({ biometricFailureReason: "vlm_liveness_failed" }),
      }),
    }))
  })

  it.each([
    ["a readable verdict", {}, "ID document portrait is not a photograph (silhouette_placeholder)", {
      idPhotoKind: "silhouette_placeholder", idPhotoIsRealPhotograph: false,
      idPhotoFaceDetected: false, selfieIsRealPhotograph: true,
    }],
    // The explicit false names the message ahead of the unrecognised kind.
    ["an unreadable verdict", { matchConfidence: undefined, idPhotoKind: { value: "grey_avatar" } },
      "ID document portrait is not a real photograph of a person", {
      idPhotoKind: "unrecognised", idPhotoIsRealPhotograph: false,
      idPhotoFaceDetected: false, selfieIsRealPhotograph: true,
    }],
  ])("audits the side judgements behind a strict refusal with no provider result (%s)", async (
    _label, change, rejection, judgement,
  ) => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: { ...verdictBase, ...silhouetteId, isLive: { value: false }, ...change },
    })

    await POST(request() as never)

    await vi.waitFor(() => expect(auditCreateMock).toHaveBeenCalledTimes(2))
    const audit = auditCreateMock.mock.calls[1][0] as {
      data: { action: string; newValue: { document: { faceMatchVerdict: unknown } } }
    }
    expect(audit.data.action).toBe("KYC_REJECTED")
    expect(audit.data.newValue.document.faceMatchVerdict).toEqual({
      provider: "vlm-face-match-v2",
      rejection,
      ...judgement,
    })
  })

  // REPRO D: a side flag present as "false", 0 or a nested object read as
  // absent, so a silhouette ID or fake selfie behind a liveness failure was
  // recorded under the exceptionable vlm_liveness_failed. Fail closed, with a
  // message that claims nothing about the photo.
  const unreadableId = "ID document portrait could not be verified: the check's answer about it was unreadable"
  const unreadableSelfie = "Selfie could not be verified as a real photograph: the check's answer about it was unreadable"
  const goodIdPair = {
    idPhotoKind: { value: "photograph" },
    idPhotoIsRealPhotograph: { value: true },
    idPhotoFaceDetected: { value: true },
  }
  it.each([
    ["silhouette ID, kind omitted, idPhotoIsRealPhotograph \"false\"",
      { idPhotoIsRealPhotograph: { value: "false" } }, "id_document_portrait_invalid", unreadableId],
    ["silhouette ID, kind omitted, idPhotoIsRealPhotograph {value:false}",
      { idPhotoIsRealPhotograph: { value: { value: false } } }, "id_document_portrait_invalid", unreadableId],
    ["silhouette ID, idPhotoFaceDetected 0, other ID flags omitted",
      { idPhotoFaceDetected: { value: 0 } }, "id_document_portrait_invalid", unreadableId],
    ["good ID pair, selfieIsRealPhotograph 0",
      { ...goodIdPair, selfieIsRealPhotograph: { value: 0 } }, "selfie_not_real_photograph", unreadableSelfie],
    ["good ID pair, selfieIsRealPhotograph \"false\"",
      { ...goodIdPair, selfieIsRealPhotograph: { value: "false" } }, "selfie_not_real_photograph", unreadableSelfie],
    // The model answered null for every ID judgement (mapExtractedFields
    // drops null), so nothing judged the portrait.
    ["every ID judgement null",
      { idPhotoKind: null, idPhotoIsRealPhotograph: null, idPhotoFaceDetected: null },
      "id_document_portrait_invalid", "ID document portrait could not be verified: the check gave no answer about it"],
    ["good ID pair, selfie judgement omitted",
      { ...goodIdPair, selfieIsRealPhotograph: undefined },
      "selfie_not_real_photograph", "Selfie could not be verified as a real photograph: the check gave no answer about it"],
  ])("records isLive:false with %s under a non-exceptionable reason", async (_label, sides, reason, message) => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: true,
      data: { ...verdictBase, isLive: { value: false }, livenessConfidence: { value: 0.2 }, ...sides },
    })

    await POST(request() as never)

    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    const update = txDocumentUpdateManyMock.mock.calls[0][0] as {
      data: {
        verified: boolean
        extractionError: string
        verificationNote: string
        biometricResult: { biometricFailureReason: string }
      }
    }
    expect(update.data.verified).toBe(false)
    expect(update.data.biometricResult.biometricFailureReason).toBe(reason)
    expect(isManualKycExceptionableFailureReason(update.data.biometricResult.biometricFailureReason)).toBe(false)
    expect(update.data.extractionError).toBe(message)
    expect(update.data.verificationNote).toBe(message)
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
        // The reply judged neither photo: a fault in the check, not the ID,
        // and not exceptionable either.
        biometricResult: expect.objectContaining({
          biometricFailureReason: "extraction_incomplete",
          idDocumentId: "id-doc-1",
          idDocumentSha256: "c".repeat(64),
        }),
      }),
    }))
    expect(auditCreateMock.mock.calls[1][0]).toEqual({
      data: expect.objectContaining({ action: "KYC_REJECTED" }),
    })
  })

  it("does not bind provider evidence to an ID document replaced during the callback", async () => {
    // The persist gate re-reads the CURRENT ID document inside the money
    // transaction; the evidence names id-doc-1, but a newer ID landed.
    // Same digest, so only the row comparison can refuse it.
    txDocumentFindManyMock.mockResolvedValueOnce([{ id: "id-doc-REPLACED", contentSha256: "c".repeat(64) }])

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

  it("re-checks the bound ID copy against the newest uploaded one, digest included", async () => {
    // Same row, different bytes: the compared copy is no longer what is on file.
    txDocumentFindManyMock.mockResolvedValueOnce([{ id: "id-doc-1", contentSha256: "d".repeat(64) }])

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(txDocumentUpdateManyMock).toHaveBeenCalledOnce())
    // Verified or not (the composite gate's call), but never one staff rejected.
    expect(txDocumentFindManyMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: { tenantId: "tenant-1", clientId: "client-1", docType: "ID_COPY", deletedAt: null, verificationRejectedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }))
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        verified: false,
        biometricResult: expect.objectContaining({ biometricFailureReason: "subject_identity_changed" }),
      }),
    }))
  })

  it("compares the selfie against the newest ID copy staff have not rejected, verified or not", async () => {
    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    const newestIdCopy = {
      where: { tenantId: "tenant-1", clientId: "client-1", docType: "ID_COPY", deletedAt: null, verificationRejectedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }
    expect(outsideDocumentFindFirstMock.mock.calls[0][0]).toEqual(expect.objectContaining(newestIdCopy))
    expect(txDocumentFindFirstMock.mock.calls[0][0]).toEqual(expect.objectContaining(newestIdCopy))
  })

  it.each([
    ["there is no ID copy at all", null],
    ["the newest copy has no digest", { contentSha256: null }],
  ])("refuses capture when %s", async (_label, newestCopy) => {
    outsideDocumentFindFirstMock.mockReset()
    outsideDocumentFindFirstMock.mockResolvedValueOnce(newestCopy)

    const response = await POST(request() as never)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: "Please upload your ID document before taking a selfie." })
    expect(saveFileMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("refuses inside the evidence lock when the ID copy lost its digest", async () => {
    txDocumentFindFirstMock.mockReset()
    txDocumentFindFirstMock.mockResolvedValueOnce({ ...ID_DOCUMENT_ROW, contentSha256: null })

    const response = await POST(request() as never)

    expect(response.status).toBe(422)
    expect(txDocumentCreateMock).not.toHaveBeenCalled()
    expect(deleteFileMock).toHaveBeenCalledWith("tenant-1/client-1/selfie.jpg")
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
