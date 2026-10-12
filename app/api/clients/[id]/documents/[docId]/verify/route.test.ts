import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
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
  id: "selfie-doc-1",
  clientId: "client-1",
  docType: "SELFIE",
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
  biometricVerifiedAt: new Date("2026-07-22T10:00:00.000Z"),
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

const verifiedCoreDocuments = [
  { id: "id-doc-1", docType: "ID_COPY", verified: true, verificationNote: null, contentSha256: "c".repeat(64) },
  { docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
  { docType: "PAYSLIP", verified: true, verificationNote: null },
  { docType: "BANK_STATEMENT", verified: true, verificationNote: null },
]

const requireApiRoleMock = vi.fn()
const queryRawMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const documentFindFirstMock = vi.fn()
const documentUpdateManyMock = vi.fn()
const documentFindManyMock = vi.fn()
const clientUpdateMock = vi.fn()
const auditCreateMock = vi.fn()
const transactionMock = vi.fn()

const tx = {
  $queryRaw: (query: unknown) => queryRawMock(query),
  client: {
    findUnique: (args: unknown) => clientFindUniqueMock(args),
    update: (args: unknown) => clientUpdateMock(args),
  },
  clientDocument: {
    findFirst: (args: unknown) => documentFindFirstMock(args),
    updateMany: (args: unknown) => documentUpdateManyMock(args),
    findMany: (args: unknown) => documentFindManyMock(args),
  },
  auditLog: {
    create: (args: unknown) => auditCreateMock(args),
  },
}

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    cb: (tenant: { id: string }) => Promise<unknown>,
  ) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (client: typeof tx) => Promise<unknown>) => transactionMock(cb),
  },
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: {
    BIOMETRIC_VERIFICATION_BLOCKED: "BIOMETRIC_VERIFICATION_BLOCKED",
    DOCUMENT_VERIFIED: "DOCUMENT_VERIFIED",
    KYC_REJECTED: "KYC_REJECTED",
  },
}))

import { PATCH } from "./route"

function verificationRequest(body: unknown) {
  return new NextRequest(
    "https://staging.acme-lending.example/api/clients/client-1/documents/doc-1/verify",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
}

describe("PATCH /api/clients/[id]/documents/[docId]/verify", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    transactionMock.mockImplementation((cb: (client: typeof tx) => Promise<unknown>) => cb(tx))
    requireApiRoleMock.mockResolvedValue({
      user: { id: "officer-1", email: "officer@example.test" },
    })
    queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
    clientFindUniqueMock.mockResolvedValue({
      ...biometricSubject,
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
      kycVerifiedById: "officer-previous",
      kycVerificationMethod: "SMILE_IDENTITY",
    })
    // readCompositeKycState makes a THIRD findFirst call, for the latest selfie.
    // Unconfigured it returned undefined, and `undefined !== null` made
    // biometricDocumentPresent true — so the rejection test below used to reach
    // FAILED through the BIOMETRIC branch by accident rather than through the
    // document refusal it claims to exercise. A base value covers any call the
    // per-test queue does not, without shifting that queue's positions.
    documentFindFirstMock.mockResolvedValue(null)
    documentFindFirstMock
      .mockResolvedValueOnce({
        id: "doc-1",
        clientId: "client-1",
        docType: "BANK_STATEMENT",
        deletedAt: null,
        verified: true,
        verifiedAt: new Date("2026-07-20T08:00:00.000Z"),
        verifiedById: "officer-previous",
        verificationNote: null,
      })
      .mockResolvedValueOnce({
        id: "doc-1",
        clientId: "client-1",
        deletedAt: null,
        verified: false,
      })
    documentUpdateManyMock.mockResolvedValue({ count: 1 })
    documentFindManyMock.mockResolvedValue([
      {
        id: "doc-1",
        docType: "BANK_STATEMENT",
        verified: false,
        verificationNote: "revoked",
        // The officer who refused it — this is what makes it a rejection
        // rather than a system re-flag, and what drives client-level FAILED.
        verificationRejectedById: "officer-1",
        createdAt: new Date("2026-07-20T08:00:00.000Z"),
      },
    ])
    clientUpdateMock.mockResolvedValue({
      id: "client-1",
      kycStatus: "FAILED",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    })
    auditCreateMock.mockResolvedValue({ id: "audit-1" })
  })

  it("clears the refusal author when the document is later accepted", async () => {
    // Otherwise a document could read as verified AND refused at once, and the
    // client would stay FAILED after the problem was resolved.
    await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(documentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        verified: true,
        verificationRejectedById: null,
        verificationRejectedAt: null,
      }),
    }))
  })

  it("serializes unverification and the KYC roll-up with disbursement", async () => {
    const response = await PATCH(
      verificationRequest({ verified: false, rejectReason: "  revoked  " }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(200)
    expect(requireApiRoleMock).toHaveBeenCalledWith("CREDIT_OFFICER")
    expect(await response.json()).toEqual(expect.objectContaining({ kycStatus: "FAILED" }))
    expect(queryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-client:tenant-1:client-1"],
    }))
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      documentUpdateManyMock.mock.invocationCallOrder[0],
    )
    expect(documentUpdateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      clientUpdateMock.mock.invocationCallOrder[0],
    )
    // Assert what the Client write was CALLED WITH, not what its mock returns.
    // The response body and audit both echo clientUpdateMock's stubbed value,
    // so they stay green even if the derivation stops producing FAILED — this
    // is the assertion that actually proves the route forwards it.
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
    expect(documentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        verificationNote: "revoked",
        // The author is what separates a refusal from the SYSTEM re-flagging a
        // statement after a bank-detail change, which writes an identical row
        // otherwise. Drop this and the client-level FAILED signal silently goes
        // with it, so pin it here rather than only at the derivation.
        verificationRejectedById: "officer-1",
        verificationRejectedAt: expect.any(Date),
      }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "KYC_REJECTED",
        oldValue: {
          document: {
            verified: true,
            verifiedAt: "2026-07-20T08:00:00.000Z",
            verifiedById: "officer-previous",
            verificationNote: null,
          },
          clientKyc: {
            kycStatus: "VERIFIED",
            kycVerifiedAt: "2026-07-20T08:00:00.000Z",
            kycVerifiedById: "officer-previous",
            kycVerificationMethod: "SMILE_IDENTITY",
          },
        },
        newValue: {
          document: { verified: false, note: "revoked" },
          clientKyc: {
            kycStatus: "FAILED",
            kycVerifiedAt: null,
            kycVerifiedById: null,
            kycVerificationMethod: null,
          },
        },
      }),
    })
    expect(clientUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      auditCreateMock.mock.invocationCallOrder[0],
    )
  })

  it("refuses to mutate a retained credit agreement", async () => {
    documentFindFirstMock.mockReset().mockResolvedValueOnce({
      id: "doc-1",
      clientId: "client-1",
      docType: "CREDIT_AGREEMENT",
      deletedAt: null,
    })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Credit-agreement records are immutable and cannot be verified through the generic document workflow",
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("preserves the retained debit-mandate verification refusal", async () => {
    documentFindFirstMock.mockReset().mockResolvedValueOnce({
      id: "doc-1",
      clientId: "client-1",
      docType: "DEBIT_MANDATE",
      deletedAt: null,
    })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Signed debit-mandate records are immutable and cannot be verified through the generic document workflow",
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("refuses to mutate locked Form 20 statutory evidence", async () => {
    documentFindFirstMock.mockReset().mockResolvedValueOnce({
      id: "doc-1",
      clientId: "client-1",
      docType: "FORM_20_PRE_AGREEMENT",
      deletedAt: null,
    })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Form 20/PASQ is locked statutory evidence; complete it through the signing and acknowledgement workflow",
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("blocks a no-face, failed-liveness selfie even when staff requests verification", async () => {
    documentFindFirstMock.mockReset()
      .mockResolvedValueOnce({
        id: "doc-1",
        clientId: "client-1",
        docType: "SELFIE",
        deletedAt: null,
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: null,
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
        biometricMatchScore: null,
        biometricLiveness: null,
        biometricVerifiedAt: null,
        biometricResult: null,
      })
      .mockResolvedValueOnce({ id: "doc-1" })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      biometricEvidence: "face_not_detected",
    }))
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(documentFindFirstMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      where: expect.not.objectContaining({ deletedAt: null }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "BIOMETRIC_VERIFICATION_BLOCKED",
        newValue: expect.objectContaining({
          attemptedVerified: true,
          blocked: true,
          reason: "face_not_detected",
        }),
      }),
    })
  })

  // The refusal message is a factual claim about a client's file. One sentence
  // used to serve all seventeen reasons: "stored biometric evidence did not
  // establish exactly one live, usable, matching face." For a selfie refused
  // because the client's details were edited afterwards that is FALSE — the
  // check established exactly that, at 90% match and 95% liveness — and the
  // wording reads as a failed or fraudulent capture instead of a record change.
  it("explains a refusal in wording that is true for the actual reason", async () => {
    // beforeEach queues two values; without a reset this selfie lands third and
    // the route sees the BANK_STATEMENT fixture instead, skipping the gate.
    documentFindFirstMock.mockReset()
      .mockResolvedValueOnce({
        id: "doc-1",
        clientId: "client-1",
        docType: "SELFIE",
        deletedAt: null,
        verified: false,
        verificationNote: null,
        extractionStatus: "done",
        extractionResult: {
          faceDetected: { value: true },
          facesCount: { value: 1 },
          isLive: { value: true },
          quality: { value: "good" },
        },
        extractionError: null,
        validationMismatch: false,
        validationScore: 90,
        biometricMatchScore: 90,
        biometricLiveness: 95,
        biometricVerifiedAt: new Date("2026-08-14T12:53:00.000Z"),
        // Bound to a subject that is no longer this client's — the fingerprint
        // does not match, so the gate refuses with subject_identity_changed.
        biometricResult: {
          ok: true,
          verified: true,
          matchScore: 90,
          livenessScore: 95,
          provider: "vlm-face-match-v3",
          faceModel: PASSING_FACE_MODEL_EVIDENCE,
          idPhotoKind: "photograph",
          idPhotoIsRealPhotograph: true,
          idPhotoFaceDetected: true,
          selfieIsRealPhotograph: true,
          samePerson: "same",
          faceMatch: true,
          matchConfidence: 0.9,
          livenessConfidence: 0.95,
          subjectFingerprint: "c".repeat(64),
        },
      })
      .mockResolvedValueOnce({ id: "doc-1" })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.biometricEvidence).toBe("subject_identity_changed")
    // The claim that must not be made about a check that scored 90/95.
    expect(body.error).not.toContain("did not establish")
    expect(body.error).toContain("Record changed after the check")
    expect(body.error).toContain("has changed since this check began")
  })

  it("accepts a selfie only when both extraction and provider evidence pass", async () => {
    const biometricVerifiedAt = new Date("2026-07-22T10:00:00.000Z")
    documentFindFirstMock.mockReset()
      .mockResolvedValueOnce({
        id: "doc-1",
        clientId: "client-1",
        docType: "SELFIE",
        deletedAt: null,
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: null,
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
        biometricVerifiedAt,
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
      })
      .mockResolvedValueOnce({ id: "doc-1" })
      // The newest verified ID copy, which the selfie was compared against.
      .mockResolvedValueOnce({ id: "id-doc-1", contentSha256: "c".repeat(64) })
      .mockResolvedValueOnce({ ...passingSelfieDocument, id: "doc-1" })
      .mockResolvedValueOnce({ ...passingSelfieDocument, id: "doc-1" })
    documentFindManyMock.mockResolvedValueOnce(verifiedCoreDocuments)
    clientUpdateMock.mockResolvedValueOnce({
      kycStatus: "VERIFIED",
      kycVerifiedAt: biometricVerifiedAt,
      kycVerifiedById: "officer-1",
      kycVerificationMethod: "BIOMETRIC",
    })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(200)
    expect(documentFindManyMock).toHaveBeenCalledOnce()
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: expect.any(Date),
        kycVerifiedById: "officer-1",
        kycVerificationMethod: "BIOMETRIC",
      },
    }))
  })

  it("refuses a selfie matched against an ID copy that is not the newest verified one", async () => {
    documentFindFirstMock.mockReset()
      .mockResolvedValueOnce({
        ...passingSelfieDocument,
        id: "doc-1",
        clientId: "client-1",
        docType: "SELFIE",
        verified: false,
        verifiedAt: null,
        verifiedById: null,
      })
      .mockResolvedValueOnce({ id: "doc-1" })
      // A newer copy has since been verified; the match names id-doc-1.
      .mockResolvedValueOnce({ id: "id-doc-2", contentSha256: "d".repeat(64) })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(422)
    expect((await response.json()).biometricEvidence).toBe("subject_identity_changed")
    expect(documentFindFirstMock.mock.calls[2][0]).toEqual({
      where: { tenantId: "tenant-1", clientId: "client-1", docType: "ID_COPY", deletedAt: null, verified: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, contentSha256: true },
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
  })

  it("cannot approve an older selfie after a newer attempt superseded it", async () => {
    const biometricVerifiedAt = new Date("2026-07-22T10:00:00.000Z")
    documentFindFirstMock.mockReset()
      .mockResolvedValueOnce({
        id: "doc-1",
        clientId: "client-1",
        docType: "SELFIE",
        deletedAt: null,
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: null,
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
        biometricVerifiedAt,
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
      })
      .mockResolvedValueOnce({ id: "newer-selfie" })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      biometricEvidence: "superseded_biometric_evidence",
    }))
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "BIOMETRIC_VERIFICATION_BLOCKED",
        newValue: expect.objectContaining({
          reason: "superseded_biometric_evidence",
          latestSelfieId: "newer-selfie",
        }),
      }),
    })
  })

  it("cannot reject an older selfie after a newer attempt superseded it", async () => {
    documentFindFirstMock.mockReset()
      .mockResolvedValueOnce({
        id: "doc-1",
        clientId: "client-1",
        docType: "SELFIE",
        deletedAt: null,
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: null,
      })
      .mockResolvedValueOnce({ id: "newer-selfie" })

    const response = await PATCH(
      verificationRequest({ verified: false, rejectReason: "old attempt" }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      biometricEvidence: "superseded_biometric_evidence",
    }))
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "BIOMETRIC_VERIFICATION_BLOCKED",
        newValue: expect.objectContaining({
          attemptedVerified: false,
          reason: "superseded_biometric_evidence",
          latestSelfieId: "newer-selfie",
        }),
      }),
    })
  })

  it.each([
    [{}, "verified must be a boolean"],
    [{ verified: "false" }, "verified must be a boolean"],
    [{ verified: false }, "A rejection reason is required when verification is rejected"],
    [{ verified: false, rejectReason: "   " }, "A rejection reason is required when verification is rejected"],
    [{ verified: true, note: 42 }, "note must be a string"],
    [{ verified: false, rejectReason: 42 }, "rejectReason must be a string"],
  ])("rejects malformed verification state %# before opening a transaction", async (body, error) => {
    const response = await PATCH(
      verificationRequest(body),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error })
    expect(transactionMock).not.toHaveBeenCalled()
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("denies roles below CREDIT_OFFICER before opening a transaction", async () => {
    requireApiRoleMock.mockResolvedValueOnce({
      error: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("CREDIT_OFFICER")
    expect(transactionMock).not.toHaveBeenCalled()
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("fails closed when the transactional audit insert fails", async () => {
    auditCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await PATCH(
      verificationRequest({ verified: false, rejectReason: "revoked" }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(500)
    expect(auditCreateMock).toHaveBeenCalledOnce()
  })

  it("records PHYSICAL provenance when the complete core set becomes verified", async () => {
    documentFindManyMock.mockResolvedValueOnce(verifiedCoreDocuments)
    documentFindFirstMock.mockResolvedValueOnce(passingSelfieDocument)
    clientUpdateMock.mockResolvedValueOnce({
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-21T10:00:00.000Z"),
      kycVerifiedById: "officer-1",
      kycVerificationMethod: "PHYSICAL",
    })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalledWith({
      where: { id: "client-1", tenantId: "tenant-1" },
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: expect.any(Date),
        kycVerifiedById: "officer-1",
        kycVerificationMethod: "PHYSICAL",
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
        newValue: expect.objectContaining({
          clientKyc: {
            kycStatus: "VERIFIED",
            kycVerifiedAt: "2026-07-21T10:00:00.000Z",
            kycVerifiedById: "officer-1",
            kycVerificationMethod: "PHYSICAL",
          },
        }),
      }),
    })
  })

  it("does not mark a core-document-only client verified without a current selfie", async () => {
    documentFindManyMock.mockResolvedValueOnce(verifiedCoreDocuments)
    documentFindFirstMock.mockResolvedValueOnce(null)
    clientUpdateMock.mockResolvedValueOnce({
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    })

    const response = await PATCH(
      verificationRequest({ verified: true }),
      { params: Promise.resolve({ id: "client-1", docId: "doc-1" }) },
    )

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    }))
  })
})
