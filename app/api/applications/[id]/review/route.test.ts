import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "@/lib/kyc/face-model/evidence.test-helpers"

const requireApiRoleMock = vi.fn()
const findUniqueMock = vi.fn()
const updateManyMock = vi.fn()
const clientDocumentFindManyMock = vi.fn()
const clientDocumentFindFirstMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const queryRawMock = vi.fn()
const auditLogCreateMock = vi.fn()
const transactionMock = vi.fn()
const runBureauReviewCheckMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: {
      findUnique: (a: unknown) => findUniqueMock(a),
    },
    clientDocument: { findMany: (a: unknown) => clientDocumentFindManyMock(a) },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: {
    APPLICATION_REVIEW_STARTED: "APPLICATION_REVIEW_STARTED",
    APPLICATION_BUREAU_REVIEW_RETRIED: "APPLICATION_BUREAU_REVIEW_RETRIED",
    BIOMETRIC_VERIFICATION_BLOCKED: "BIOMETRIC_VERIFICATION_BLOCKED",
    KYC_VERIFICATION_BLOCKED: "KYC_VERIFICATION_BLOCKED",
  },
}))
vi.mock("@/lib/compliance/bureau-review", () => ({
  runBureauReviewCheck: (args: unknown) => runBureauReviewCheckMock(args),
}))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1" }) }
function makeReq() {
  return new NextRequest("http://x/api/applications/app-1/review", {
    method: "POST",
    headers: { accept: "application/json" },
  })
}

const applicationWithClient = {
  id: "app-1",
  status: "SUBMITTED",
  updatedAt: new Date("2026-07-23T01:00:00.000Z"),
  clientId: "client-1",
  assignedToId: null,
  bureauReviewGeneration: null,
  client: { idNumber: "9001016000082", firstName: "A", lastName: "B" },
}

const clientSubject = {
  id: "client-1",
  idNumber: "9001016000082",
  firstName: "A",
  lastName: "B",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
}
const verifiedCoreDocuments = [
  "ID_COPY",
  "PROOF_OF_ADDRESS",
  "PAYSLIP",
  "BANK_STATEMENT",
].map((docType) => ({ docType, verified: true, verificationNote: null }))
const passingSelfie = {
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
  biometricVerifiedAt: new Date("2026-07-18T10:00:00.000Z"),
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
    subjectFingerprint: biometricSubjectFingerprint(clientSubject),
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "officer@x.co" } })
  updateManyMock.mockResolvedValue({ count: 1 })
  clientDocumentFindManyMock.mockImplementation((args: { where?: { docType?: { in?: string[] } } }) => (
    args.where?.docType && "in" in args.where.docType
      ? Promise.resolve(verifiedCoreDocuments)
      : Promise.resolve([])
  ))
  clientDocumentFindFirstMock.mockResolvedValue(passingSelfie)
  clientFindUniqueMock.mockResolvedValue({
    ...clientSubject,
    kycStatus: "VERIFIED",
    kycVerifiedAt: new Date("2026-07-18T10:00:00.000Z"),
    kycVerifiedById: null,
    kycVerificationMethod: "SMILE_IDENTITY",
  })
  queryRawMock.mockResolvedValue([{ lockResult: "" }])
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({
    $queryRaw: queryRawMock,
    client: { findUnique: clientFindUniqueMock },
    clientDocument: {
      findMany: clientDocumentFindManyMock,
      findFirst: clientDocumentFindFirstMock,
    },
    loanApplication: {
      findUnique: findUniqueMock,
      updateMany: updateManyMock,
    },
    auditLog: { create: auditLogCreateMock },
  }))
  runBureauReviewCheckMock.mockResolvedValue("stored")
})

it("claims a SUBMITTED application into UNDER_REVIEW (happy path)", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)

  const res = await POST(makeReq(), ctx)
  const json = await res.json() as { ok: boolean; status: string }

  expect(res.status).toBe(200)
  expect(json).toEqual({
    ok: true,
    id: "app-1",
    status: "UNDER_REVIEW",
    bureauResult: "stored",
    bureauReviewRetried: false,
  })
  expect(updateManyMock).toHaveBeenCalledWith({
    where: {
      id: "app-1",
      tenantId: "t1",
      status: "SUBMITTED",
      updatedAt: applicationWithClient.updatedAt,
      bureauReviewGeneration: null,
    },
    data: {
      status: "UNDER_REVIEW",
      assignedToId: "u1",
      bureauReviewGeneration: expect.any(String),
    },
  })
  const reviewGeneration = updateManyMock.mock.calls[0][0].data.bureauReviewGeneration
  expect(runBureauReviewCheckMock).toHaveBeenCalledWith({
    tenantId: "t1",
    applicationId: "app-1",
    clientId: "client-1",
    reviewGeneration,
  })
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "APPLICATION_REVIEW_STARTED",
      entityId: "app-1",
    }),
  })
  expect(queryRawMock.mock.invocationCallOrder[1]).toBeLessThan(
    findUniqueMock.mock.invocationCallOrder[0],
  )
})

it("starts review with no selfie captured yet — biometrics gate payout, not origination", async () => {
  // Policy: a selfie is not compulsory to review or approve an
  // application, only to disburse. An absent capture is a missing step, not an
  // adverse result, so origination proceeds. A FAILED capture still blocks —
  // see the biometric-failure cases below, which are unaffected.
  findUniqueMock.mockResolvedValue(applicationWithClient)
  clientDocumentFindFirstMock.mockResolvedValueOnce(null)

  const response = await POST(makeReq(), ctx)

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ok: true,
    id: "app-1",
    status: "UNDER_REVIEW",
    bureauResult: "stored",
    bureauReviewRetried: false,
  })
  expect(updateManyMock).toHaveBeenCalled()
  expect(runBureauReviewCheckMock).toHaveBeenCalled()
  expect(auditLogCreateMock).not.toHaveBeenCalledWith({
    data: expect.objectContaining({ action: "BIOMETRIC_VERIFICATION_BLOCKED" }),
  })
})

it("blocks review while an explicit manual KYC rejection remains active", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)
  clientFindUniqueMock.mockResolvedValueOnce({
    ...clientSubject,
    kycStatus: "FAILED",
    kycVerifiedAt: null,
    kycVerifiedById: null,
    kycVerificationMethod: null,
    kycManualRejectionActive: true,
    kycManualRejectionAt: new Date("2026-07-23T01:00:00.000Z"),
    kycManualRejectionById: "compliance-1",
    kycManualRejectionReason: "Identity evidence requires investigation",
  })

  const response = await POST(makeReq(), ctx)

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: "Cannot submit for review: the client's manual KYC rejection must be resolved by an authorised KYC decision.",
    biometricEvidence: "manual_rejection_active",
    manualRejectionReason: "Identity evidence requires investigation",
  })
  expect(clientDocumentFindManyMock).not.toHaveBeenCalled()
  expect(clientDocumentFindFirstMock).not.toHaveBeenCalled()
  expect(updateManyMock).not.toHaveBeenCalled()
  expect(runBureauReviewCheckMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "KYC_VERIFICATION_BLOCKED",
      newValue: expect.objectContaining({ reason: "manual_rejection_active" }),
    }),
  })
})

it("reports an evidence-derived FAILED selfie as biometric failure, not a manual rejection", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)
  clientFindUniqueMock.mockResolvedValueOnce({
    ...clientSubject,
    kycStatus: "FAILED",
    kycVerifiedAt: null,
    kycVerifiedById: null,
    kycVerificationMethod: null,
    kycManualRejectionActive: false,
  })
  clientDocumentFindFirstMock.mockResolvedValueOnce({
    ...passingSelfie,
    verified: false,
    validationMismatch: true,
    validationScore: 0,
    biometricMatchScore: 0,
    biometricLiveness: 0,
    biometricVerifiedAt: null,
    biometricResult: { ok: false, verified: false },
  })

  const response = await POST(makeReq(), ctx)

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual(expect.objectContaining({
    biometricEvidence: expect.not.stringMatching(/manual_rejection/),
  }))
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "BIOMETRIC_VERIFICATION_BLOCKED",
      newValue: expect.objectContaining({
        reason: expect.not.stringMatching(/manual_rejection/),
      }),
    }),
  })
})

it("blocks review when a valid selfie is missing verified core documents", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)
  clientDocumentFindManyMock.mockResolvedValueOnce(
    verifiedCoreDocuments.filter(({ docType }) =>
      docType !== "PAYSLIP" && docType !== "PROOF_OF_ADDRESS"),
  )

  const response = await POST(makeReq(), ctx)

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: "Cannot submit for review: all required KYC documents must be verified.",
    missingDocs: ["PROOF_OF_ADDRESS", "PAYSLIP"],
  })
  expect(updateManyMock).not.toHaveBeenCalled()
  expect(runBureauReviewCheckMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "KYC_VERIFICATION_BLOCKED",
      newValue: expect.objectContaining({
        reason: "core_documents_incomplete",
        missingDocs: ["PROOF_OF_ADDRESS", "PAYSLIP"],
      }),
    }),
  })
})

it("surfaces the core-documents blocker when docs are unverified AND the selfie failed", async () => {
  // Regression: with unverified core documents, `biometricEvidence` is often
  // non-null too (a failed or absent selfie). The route used to lead with the
  // selfie 422, hiding the actionable next step (verify the documents).
  findUniqueMock.mockResolvedValue(applicationWithClient)
  clientDocumentFindManyMock.mockResolvedValueOnce(
    verifiedCoreDocuments.filter(({ docType }) => docType !== "PAYSLIP"),
  )
  clientDocumentFindFirstMock.mockResolvedValueOnce({
    ...passingSelfie,
    verified: false,
    validationMismatch: true,
    validationScore: 0,
    biometricMatchScore: 0,
    biometricLiveness: 0,
    biometricVerifiedAt: null,
    biometricResult: { ok: false, verified: false },
  })

  const response = await POST(makeReq(), ctx)

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: "Cannot submit for review: all required KYC documents must be verified.",
    missingDocs: ["PAYSLIP"],
  })
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "KYC_VERIFICATION_BLOCKED",
      newValue: expect.objectContaining({
        reason: "core_documents_incomplete",
        missingDocs: ["PAYSLIP"],
      }),
    }),
  })
})

it("409s when a concurrent claim already moved the application off SUBMITTED (race guard), skips audit", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)
  updateManyMock.mockResolvedValue({ count: 0 })

  const res = await POST(makeReq(), ctx)

  expect(res.status).toBe(409)
  expect(auditLogCreateMock).not.toHaveBeenCalled()
})

it("blocks a legacy invalid latest selfie even when its verified flag is true", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)
  clientDocumentFindFirstMock.mockResolvedValueOnce({
    id: "selfie-corrupt",
    deletedAt: null,
    verified: true,
    extractionStatus: "done",
    extractionResult: {
      faceDetected: { value: false },
      facesCount: { value: 0 },
      isLive: { value: false },
      quality: { value: "unusable" },
    },
    extractionError: null,
    validationMismatch: true,
    validationScore: 0,
    biometricMatchScore: 0,
    biometricLiveness: 0,
    biometricVerifiedAt: new Date("2026-07-18T10:00:00.000Z"),
    biometricResult: { ok: true, verified: false, matchScore: 0, livenessScore: 0 },
  })

  const response = await POST(makeReq(), ctx)

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: "Cannot submit for review: the latest selfie does not establish current valid biometric evidence.",
    biometricEvidence: "face_not_detected",
    documentId: "selfie-corrupt",
  })
  expect(updateManyMock).not.toHaveBeenCalled()
  expect(runBureauReviewCheckMock).not.toHaveBeenCalled()
  expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
    clientDocumentFindFirstMock.mock.invocationCallOrder[0],
  )
  expect(clientDocumentFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.not.objectContaining({ deletedAt: null }),
    orderBy: [
      { biometricAttemptSequence: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ],
  }))
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "BIOMETRIC_VERIFICATION_BLOCKED",
      entityId: "app-1",
      newValue: expect.objectContaining({ reason: "face_not_detected" }),
    }),
  })
})

it("gives a normal failed selfie the distinct biometric 422 before generic mismatches", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)
  const failedSelfie = {
    id: "selfie-failed",
    docType: "SELFIE",
    fileName: "selfie.jpg",
    deletedAt: null,
    verified: false,
    extractionStatus: "failed",
    extractionResult: {
      faceDetected: { value: false },
      facesCount: { value: 0 },
      isLive: { value: false },
      quality: { value: "unusable" },
    },
    extractionError: "No face detected",
    validationMismatch: true,
    validationScore: 0,
    biometricMatchScore: null,
    biometricLiveness: null,
    biometricVerifiedAt: null,
    biometricResult: null,
  }
  clientDocumentFindFirstMock.mockResolvedValueOnce(failedSelfie)

  const response = await POST(makeReq(), ctx)

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: "Cannot submit for review: the latest selfie does not establish current valid biometric evidence.",
    biometricEvidence: "extraction_incomplete",
    documentId: "selfie-failed",
  })
  expect(clientDocumentFindManyMock).toHaveBeenCalledOnce()
  expect(updateManyMock).not.toHaveBeenCalled()
  expect(runBureauReviewCheckMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "BIOMETRIC_VERIFICATION_BLOCKED",
      entityId: "app-1",
      newValue: expect.objectContaining({ reason: "extraction_incomplete" }),
    }),
  })
})

it("excludes selfie attempts from the generic mismatch query after biometric validation", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)

  const response = await POST(makeReq(), ctx)

  expect(response.status).toBe(200)
  expect(clientDocumentFindManyMock).toHaveBeenCalledWith({
    where: {
      tenantId: "t1",
      clientId: "client-1",
      deletedAt: null,
      docType: { not: "SELFIE" },
      validationMismatch: true,
      verified: false,
    },
  })
})

it("does NOT fire the bureau check when a concurrent claim already won the race", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)
  updateManyMock.mockResolvedValue({ count: 0 })

  await POST(makeReq(), ctx)

  expect(runBureauReviewCheckMock).not.toHaveBeenCalled()
})

it("retries a migrated UNDER_REVIEW application with a new audited generation", async () => {
  findUniqueMock.mockResolvedValue({
    ...applicationWithClient,
    status: "UNDER_REVIEW",
    assignedToId: "original-officer",
    bureauReviewGeneration: "legacy-reassessment-app-1",
  })

  const res = await POST(makeReq(), ctx)
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json).toEqual(expect.objectContaining({
    bureauResult: "stored",
    bureauReviewRetried: true,
  }))
  const retryGeneration = updateManyMock.mock.calls[0][0].data.bureauReviewGeneration
  expect(retryGeneration).not.toBe("legacy-reassessment-app-1")
  expect(updateManyMock).toHaveBeenCalledWith({
    where: {
      id: "app-1",
      tenantId: "t1",
      status: "UNDER_REVIEW",
      updatedAt: applicationWithClient.updatedAt,
      bureauReviewGeneration: "legacy-reassessment-app-1",
    },
    data: {
      status: "UNDER_REVIEW",
      assignedToId: "original-officer",
      bureauReviewGeneration: retryGeneration,
    },
  })
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "APPLICATION_BUREAU_REVIEW_RETRIED",
      oldValue: expect.objectContaining({
        bureauReviewGeneration: "legacy-reassessment-app-1",
      }),
      newValue: expect.objectContaining({
        bureauReviewGeneration: retryGeneration,
        bureauRetry: true,
      }),
    }),
  })
  expect(runBureauReviewCheckMock).toHaveBeenCalledWith(expect.objectContaining({
    reviewGeneration: retryGeneration,
  }))
})

it("retries a failed UNDER_REVIEW generation and reports the newly recorded failure", async () => {
  findUniqueMock.mockResolvedValue({
    ...applicationWithClient,
    status: "UNDER_REVIEW",
    bureauReviewGeneration: "failed-generation",
  })
  runBureauReviewCheckMock.mockResolvedValue("failed")

  const res = await POST(makeReq(), ctx)
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json).toEqual(expect.objectContaining({
    bureauResult: "failed",
    bureauReviewRetried: true,
  }))
  const retryGeneration = updateManyMock.mock.calls[0][0].data.bureauReviewGeneration
  expect(retryGeneration).not.toBe("failed-generation")
  expect(runBureauReviewCheckMock).toHaveBeenCalledWith(expect.objectContaining({
    reviewGeneration: retryGeneration,
  }))
})

it("returns 409 instead of claiming success when the new bureau generation becomes stale", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)
  runBureauReviewCheckMock.mockResolvedValue("stale")

  const res = await POST(makeReq(), ctx)

  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({
    error: "The bureau review changed while the enquiry was running; refresh and try again.",
  })
})

it("400s when the application cannot start or retry review, without touching updateMany", async () => {
  findUniqueMock.mockResolvedValue({ ...applicationWithClient, status: "APPROVED" })

  const res = await POST(makeReq(), ctx)

  expect(res.status).toBe(400)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("rolls back the generation and never runs the provider when mandatory audit fails", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)
  auditLogCreateMock.mockRejectedValue(new Error("audit unavailable"))

  const res = await POST(makeReq(), ctx)

  expect(res.status).toBe(500)
  expect(updateManyMock).toHaveBeenCalled()
  expect(runBureauReviewCheckMock).not.toHaveBeenCalled()
})

it("404s when the application does not exist in the tenant", async () => {
  findUniqueMock.mockResolvedValue(null)
  const res = await POST(makeReq(), ctx)
  expect(res.status).toBe(404)
})

it("binds the audit and queued bureau check to the same new review generation", async () => {
  findUniqueMock.mockResolvedValue(applicationWithClient)

  const response = await POST(makeReq(), ctx)

  expect(response.status).toBe(200)
  const reviewGeneration = updateManyMock.mock.calls[0][0].data.bureauReviewGeneration
  expect(auditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      oldValue: expect.objectContaining({ bureauReviewGeneration: null }),
      newValue: expect.objectContaining({ bureauReviewGeneration: reviewGeneration }),
    }),
  })
  expect(runBureauReviewCheckMock).toHaveBeenCalledWith(expect.objectContaining({
    reviewGeneration,
  }))
})
