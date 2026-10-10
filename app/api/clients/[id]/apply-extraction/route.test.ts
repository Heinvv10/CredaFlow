import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"

const requireApiRoleMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const documentFindFirstMock = vi.fn()
const documentFindManyMock = vi.fn()
const documentCountMock = vi.fn()
const bureauCountMock = vi.fn()
const avsCountMock = vi.fn()
const queryRawMock = vi.fn()
const clientUpdateMock = vi.fn()
const documentUpdateManyMock = vi.fn()
const auditCreateMock = vi.fn()
const applicationFindFirstMock = vi.fn()

const previousClient = {
  id: "client-1",
  idNumber: "9001015000086",
  firstName: "Sipho",
  lastName: "Qatest",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
  kycStatus: "VERIFIED" as const,
  kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
  kycVerifiedById: null,
  kycVerificationMethod: "SMILE_IDENTITY" as const,
  bankName: "ABSA",
  bankAccountNumber: "40987654321",
  bankBranchCode: "632005",
  accountType: "SAVINGS" as const,
}

const sourceBankDocument = {
  id: "doc-1",
  clientId: "client-1",
  docType: "BANK_STATEMENT",
  extractionStatus: "done",
  extractionGeneration: "generation-a",
  validationResult: {
    isValid: true,
    matchScore: 100,
    mismatches: [],
    matches: ["Account Number"],
  },
  validationScore: 100,
  extractionResult: {
    bankName: { value: "FNB" },
    accountNumber: { value: "62000000000" },
    branchCode: { value: "250655" },
    accountType: { value: "CHEQUE" },
  },
}

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
  biometricVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
  biometricResult: {
    ok: true,
    verified: true,
    matchScore: 98,
    livenessScore: 97,
    provider: "vlm-face-match-v2",
    idPhotoKind: "photograph",
    idPhotoIsRealPhotograph: true,
    idPhotoFaceDetected: true,
    selfieIsRealPhotograph: true,
    samePerson: "same",
    faceMatch: true,
    matchConfidence: 0.98,
    livenessConfidence: 0.97,
    subjectFingerprint: biometricSubjectFingerprint(previousClient),
  },
}

const tx = {
  $queryRaw: (query: unknown) => queryRawMock(query),
  loanApplication: {
    findFirst: (args: unknown) => applicationFindFirstMock(args),
  },
  client: {
    findUnique: (args: unknown) => clientFindUniqueMock(args),
    update: (args: unknown) => clientUpdateMock(args),
  },
  clientDocument: {
    findFirst: (args: unknown) => documentFindFirstMock(args),
    findMany: (args: unknown) => documentFindManyMock(args),
    count: (args: unknown) => documentCountMock(args),
    updateMany: (args: unknown) => documentUpdateManyMock(args),
  },
  creditBureauCheck: { count: (args: unknown) => bureauCountMock(args) },
  avsCheck: { count: (args: unknown) => avsCountMock(args) },
  auditLog: { create: (args: unknown) => auditCreateMock(args) },
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
    $transaction: (cb: (client: typeof tx) => Promise<unknown>) => cb(tx),
  },
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: {
    CLIENT_UPDATED: "CLIENT_UPDATED",
    KYC_STATUS_CHANGED: "KYC_STATUS_CHANGED",
  },
}))

import { POST } from "./route"

describe("POST /api/clients/[id]/apply-extraction", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({
      user: { id: "officer-1", email: "officer@example.test" },
    })
    clientFindUniqueMock.mockResolvedValue(previousClient)
    documentFindFirstMock.mockImplementation((args: { where?: { docType?: string } }) =>
      Promise.resolve(args.where?.docType === "SELFIE" ? passingSelfie : sourceBankDocument),
    )
    documentFindManyMock.mockImplementation((args: { where?: { docType?: unknown } }) => {
      if (args.where?.docType === "BANK_STATEMENT") return Promise.resolve([{ id: "doc-1" }])
      if (args.where?.docType === "SELFIE") return Promise.resolve([])
      return Promise.resolve([
        { docType: "ID_COPY", verified: true, verificationNote: null },
        { docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
        { docType: "PAYSLIP", verified: true, verificationNote: null },
        {
          docType: "BANK_STATEMENT",
          verified: false,
          verificationNote: "Bank details changed",
        },
      ])
    })
    queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
    clientUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...previousClient,
      ...data,
    }))
    documentUpdateManyMock.mockResolvedValue({ count: 1 })
    // Default: nothing verified to lose, so the identity-revocation guard is
    // inert and the pre-existing cases keep exercising what they were written for.
    documentCountMock.mockResolvedValue(0)
    bureauCountMock.mockResolvedValue(0)
    avsCountMock.mockResolvedValue(0)
    auditCreateMock.mockResolvedValue({ id: "audit-1" })
    applicationFindFirstMock.mockResolvedValue(null)
  })

  // A PAYSLIP apply that overwrites monthlyIncome and grossMonthlyIncome
  // on a client whose application is already APPROVED and signed breaks the
  // approval: the immutable approval snapshot is fingerprinted on those inputs,
  // so the disbursement gate refuses the payout as `unchanged_affordability`
  // and nothing but a fresh approval can repair it. Extraction must not be able to invalidate an approval it cannot rebuild.
  const applyBankStatement = () => POST(new NextRequest(
    "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: "doc-1" }),
    },
  ), { params: Promise.resolve({ id: "client-1" }) })

  it("refuses to change an approval-bound field while an application is APPROVED", async () => {
    applicationFindFirstMock.mockResolvedValue({ id: "app-1", reference: "APP-0001" })

    const response = await applyBankStatement()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("APP-0001"),
    })
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
  })

  // The income case: a PAYSLIP apply, not a bank statement. Income is what
  // the affordability snapshot is fingerprinted on.
  it("refuses a payslip apply that would change income while an application is APPROVED", async () => {
    applicationFindFirstMock.mockResolvedValue({ id: "app-1", reference: "APP-0001" })
    documentFindFirstMock.mockImplementation((args: { where?: { docType?: string } }) =>
      Promise.resolve(args.where?.docType === "SELFIE" ? passingSelfie : {
        ...sourceBankDocument,
        docType: "PAYSLIP",
        extractionResult: {
          employerName: { value: "Synthetic Employer (Pty) Ltd" },
          grossIncome: { value: 2600000 },
          netIncome: { value: 700000 },
        },
      }),
    )

    const response = await applyBankStatement()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("monthlyIncome"),
    })
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  // One case per bound field, each changing EXACTLY that field and leaving the
  // rest equal to the client record. A single grouped case cannot do this job:
  // with four bank fields changing at once, removing any one of them from
  // APPROVAL_BOUND_FIELDS still refuses on the other three and the test stays
  // green while that field becomes silently mutable on an approved file.
  const dob = previousClient.dateOfBirth.toISOString()
  it.each([
    ["monthlyIncome", "PAYSLIP", { netIncome: { value: 700000 } }],
    ["grossMonthlyIncome", "PAYSLIP", { grossIncome: { value: 2600000 } }],
    ["idNumber", "ID_COPY", {
      documentNumber: { value: "8202025000087" }, firstName: { value: previousClient.firstName },
      surname: { value: previousClient.lastName }, dateOfBirth: { value: dob },
    }],
    ["firstName", "ID_COPY", {
      documentNumber: { value: previousClient.idNumber }, firstName: { value: "Renamed" },
      surname: { value: previousClient.lastName }, dateOfBirth: { value: dob },
    }],
    ["lastName", "ID_COPY", {
      documentNumber: { value: previousClient.idNumber }, firstName: { value: previousClient.firstName },
      surname: { value: "Renamed" }, dateOfBirth: { value: dob },
    }],
    ["gender", "ID_COPY", {
      documentNumber: { value: previousClient.idNumber }, firstName: { value: previousClient.firstName },
      surname: { value: previousClient.lastName }, dateOfBirth: { value: dob },
      gender: { value: "MALE" },
    }],
    ["dateOfBirth", "ID_COPY", {
      documentNumber: { value: previousClient.idNumber }, firstName: { value: previousClient.firstName },
      surname: { value: previousClient.lastName },
      dateOfBirth: { value: "1991-02-03T00:00:00.000Z" },
    }],
    ["bankName", "BANK_STATEMENT", {
      bankName: { value: "FNB" }, accountNumber: { value: previousClient.bankAccountNumber },
      branchCode: { value: previousClient.bankBranchCode }, accountType: { value: previousClient.accountType },
    }],
    ["bankAccountNumber", "BANK_STATEMENT", {
      bankName: { value: previousClient.bankName }, accountNumber: { value: "62000000000" },
      branchCode: { value: previousClient.bankBranchCode }, accountType: { value: previousClient.accountType },
    }],
    ["bankBranchCode", "BANK_STATEMENT", {
      bankName: { value: previousClient.bankName }, accountNumber: { value: previousClient.bankAccountNumber },
      branchCode: { value: "250655" }, accountType: { value: previousClient.accountType },
    }],
  ])("refuses an approved application when extraction alone changes %s", async (
    field, docType, extractionResult,
  ) => {
    applicationFindFirstMock.mockResolvedValue({ id: "app-1", reference: "APP-0001" })
    documentFindFirstMock.mockImplementation((args: { where?: { docType?: string } }) =>
      Promise.resolve(args.where?.docType === "SELFIE" ? passingSelfie : {
        ...sourceBankDocument, docType, extractionResult,
      }),
    )

    const response = await applyBankStatement()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining(field),
    })
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  // accountType is bound to an approval like the other three bank fields, but
  // extraction can only move it from a record that has none (staff-confirmed
  // wins, below). It gets its own case rather than a row in the table above so
  // that dropping "accountType" from APPROVAL_BOUND_FIELDS still fails a test.
  it("refuses an approved application when extraction sets an accountType the record lacks", async () => {
    applicationFindFirstMock.mockResolvedValue({ id: "app-1", reference: "APP-0001" })
    clientFindUniqueMock.mockResolvedValue({ ...previousClient, accountType: null })
    documentFindFirstMock.mockImplementation((args: { where?: { docType?: string } }) =>
      Promise.resolve(args.where?.docType === "SELFIE" ? passingSelfie : {
        ...sourceBankDocument,
        extractionResult: {
          bankName: { value: previousClient.bankName },
          accountNumber: { value: previousClient.bankAccountNumber },
          branchCode: { value: previousClient.bankBranchCode },
          accountType: { value: "CHEQUE" },
        },
      }),
    )

    const response = await applyBankStatement()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("accountType"),
    })
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("scopes the approved-application lookup to the tenant and client", async () => {
    applicationFindFirstMock.mockResolvedValue({ id: "app-1", reference: "APP-0001" })

    await applyBankStatement()

    expect(applicationFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "tenant-1",
        clientId: "client-1",
        status: "APPROVED",
      }),
    }))
  })

  // A re-apply of the same values changes no fingerprint, so it must not be
  // blocked — otherwise routine document housekeeping stalls on any approved
  // application.
  it("allows a re-apply whose bound values already match the client record", async () => {
    applicationFindFirstMock.mockResolvedValue({ id: "app-1", reference: "APP-0001" })
    documentFindFirstMock.mockImplementation((args: { where?: { docType?: string } }) =>
      Promise.resolve(args.where?.docType === "SELFIE" ? passingSelfie : {
        ...sourceBankDocument,
        extractionResult: {
          bankName: { value: previousClient.bankName },
          accountNumber: { value: previousClient.bankAccountNumber },
          branchCode: { value: previousClient.bankBranchCode },
          accountType: { value: previousClient.accountType },
        },
      }),
    )

    const response = await applyBankStatement()

    expect(response.status).toBe(200)
  })

  it("invalidates bank verification under the payout evidence lock", async () => {
    clientFindUniqueMock
      .mockResolvedValueOnce(previousClient)
      .mockResolvedValueOnce({
        ...previousClient,
        bankName: "FNB",
        bankAccountNumber: "62000000000",
        bankBranchCode: "250655",
        // Not CHEQUE: the statement's guessed account type is not applied over
        // the SAVINGS a staff member set, so the re-read still shows SAVINGS.
        accountType: "SAVINGS",
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      })

    const response = await POST(new NextRequest(
      "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: "doc-1" }),
      },
    ), { params: Promise.resolve({ id: "client-1" }) })

    expect(response.status).toBe(200)
    expect(queryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-client:tenant-1:client-1"],
    }))
    expect(documentFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "doc-1",
        tenantId: "tenant-1",
        clientId: "client-1",
        deletedAt: null,
      },
    }))
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      documentFindFirstMock.mock.invocationCallOrder[0],
    )
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        bankName: "FNB",
        bankAccountNumber: "62000000000",
        bankBranchCode: "250655",
      }),
    }))
    // The account number and branch code moved, so the statement is invalidated
    // — but the staff-set SAVINGS is not overwritten by the extractor's guess.
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ accountType: "CHEQUE" }),
    }))
    expect(documentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        docType: "BANK_STATEMENT",
        verified: true,
        id: { in: ["doc-1"] },
      }),
      data: expect.objectContaining({ verified: false }),
    }))
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      clientUpdateMock.mock.invocationCallOrder[0],
    )
    // The DB trigger already revoked VERIFIED -> PENDING, and the app now
    // derives PENDING too: a system re-flag records no reviewer. Agreeing with
    // the trigger leaves nothing to project, so no second Client write.
    expect(clientUpdateMock).toHaveBeenCalledTimes(1)
    expect(clientUpdateMock).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
    const kycProjectionAudit = auditCreateMock.mock.calls.find(
      (call) => call[0].data.action === "KYC_STATUS_CHANGED",
    )?.[0].data
    // No status change means no KYC_STATUS_CHANGED row for one.
    expect(kycProjectionAudit).toBeUndefined()
    expect(documentUpdateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      clientFindUniqueMock.mock.invocationCallOrder[1],
    )
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        oldValue: expect.objectContaining({
          sourceDocumentId: "doc-1",
          sourceDocumentType: "BANK_STATEMENT",
          sourceExtractionGeneration: "generation-a",
          fieldFingerprints: expect.objectContaining({ bankAccountNumber: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          bankEvidence: expect.objectContaining({ accountNumberMasked: "*******4321" }),
        }),
        newValue: expect.objectContaining({
          sourceDocumentId: "doc-1",
          sourceExtractionGeneration: "generation-a",
          bankEvidence: expect.objectContaining({ accountNumberMasked: "*******0000" }),
          bankEvidenceRevocation: {
            reason: "bank_details_changed_from_extraction",
            invalidatedDocumentIds: ["doc-1"],
            invalidatedDocumentCount: 1,
          },
        }),
      }),
    })
  })

  it("revokes biometric KYC when an acknowledged ID extraction changes the Smile subject", async () => {
    const previous = {
      id: "client-1",
      idNumber: "9001015000086",
      firstName: "Sipho",
      lastName: "Qatest",
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
      kycVerifiedById: "officer-old",
      kycVerificationMethod: "SMILE_IDENTITY",
      bankName: "ABSA",
      bankAccountNumber: "40987654321",
      bankBranchCode: "632005",
      accountType: "SAVINGS",
    }
    clientFindUniqueMock.mockResolvedValueOnce(previous)
    documentFindFirstMock.mockResolvedValueOnce({
      id: "id-doc-1",
      clientId: "client-1",
      docType: "ID_COPY",
      extractionStatus: "done",
      extractionGeneration: "generation-id",
      validationResult: { isValid: true, matchScore: 100, mismatches: [] },
      validationScore: 100,
      extractionResult: {
        documentNumber: { value: previous.idNumber },
        firstName: { value: "Nomsa" },
        surname: { value: previous.lastName },
        dateOfBirth: { value: "1990-01-01" },
      },
    })
    documentFindManyMock.mockResolvedValueOnce([{ id: "selfie-verified" }])
    clientUpdateMock.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      ...previous,
      ...data,
    }))

    const response = await POST(new NextRequest(
      "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: "id-doc-1", acknowledgeIdentityRevocation: true }),
      },
    ), { params: Promise.resolve({ id: "client-1" }) })

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        firstName: "Nomsa",
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      }),
    }))
    expect(documentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        docType: "SELFIE",
        id: { in: ["selfie-verified"] },
      }),
      data: expect.objectContaining({ verified: false, verifiedById: null }),
    }))
    const kycAudit = auditCreateMock.mock.calls.find(
      (call) => call[0].data.action === "KYC_STATUS_CHANGED",
    )?.[0].data
    expect(kycAudit).toEqual(expect.objectContaining({
      oldValue: expect.objectContaining({
        subjectFingerprint: biometricSubjectFingerprint(previous),
      }),
      newValue: expect.objectContaining({
        invalidatedDocumentIds: ["selfie-verified"],
        subjectFingerprint: biometricSubjectFingerprint({ ...previous, firstName: "Nomsa" }),
      }),
    }))
  })

  // An ID_COPY apply can destroy an in-person verification and passing
  // selfies. Nothing warns the officer, and the only route back is to
  // re-verify the person.
  describe("identity revocation is a decision, not a side effect", () => {
    const verifiedClient = {
      id: "client-1",
      idNumber: "9001015000086",
      firstName: "Sipho",
      lastName: "Qatest",
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
      kycVerifiedById: "officer-old",
      kycVerificationMethod: "PHYSICAL",
      bankName: "ABSA",
      bankAccountNumber: "40987654321",
      bankBranchCode: "632005",
      accountType: "SAVINGS",
    }

    function idCopyChangingFirstName() {
      documentFindFirstMock.mockResolvedValueOnce({
        id: "id-doc-1",
        clientId: "client-1",
        docType: "ID_COPY",
        extractionStatus: "done",
        extractionGeneration: "generation-id",
        validationResult: { isValid: true, matchScore: 100, mismatches: [] },
        validationScore: 100,
        extractionResult: {
          documentNumber: { value: verifiedClient.idNumber },
          firstName: { value: "Nomsa" },
          surname: { value: verifiedClient.lastName },
          dateOfBirth: { value: "1990-01-01" },
        },
      })
    }

    function apply(body: Record<string, unknown>) {
      return POST(new NextRequest(
        "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ), { params: Promise.resolve({ id: "client-1" }) })
    }

    it("refuses an unacknowledged apply that would revoke verified KYC", async () => {
      clientFindUniqueMock.mockResolvedValueOnce(verifiedClient)
      idCopyChangingFirstName()
      documentCountMock.mockResolvedValueOnce(2)

      const response = await apply({ documentId: "id-doc-1" })

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toContain("unusable")
      expect(body.identityRevocation).toEqual({
        changedFields: ["firstName"],
        verifiedSelfies: 2,
        bureauChecks: 0,
        avsChecks: 0,
        revokesVerifiedKyc: true,
      })
      // Nothing may be written on the refusal path.
      expect(clientUpdateMock).not.toHaveBeenCalled()
      expect(documentUpdateManyMock).not.toHaveBeenCalled()
      expect(auditCreateMock).not.toHaveBeenCalled()
    })

    it("refuses when only selfies would be lost and KYC is not yet verified", async () => {
      clientFindUniqueMock.mockResolvedValueOnce({
        ...verifiedClient,
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      })
      idCopyChangingFirstName()
      documentCountMock.mockResolvedValueOnce(1)

      const response = await apply({ documentId: "id-doc-1" })

      expect(response.status).toBe(409)
      expect((await response.json()).identityRevocation).toEqual({
        changedFields: ["firstName"],
        verifiedSelfies: 1,
        bureauChecks: 0,
        avsChecks: 0,
        revokesVerifiedKyc: false,
      })
      expect(clientUpdateMock).not.toHaveBeenCalled()
    })

    it("applies unacknowledged when the identity fields do not actually move", async () => {
      clientFindUniqueMock.mockResolvedValueOnce(verifiedClient)
      documentFindFirstMock.mockResolvedValueOnce({
        id: "id-doc-1",
        clientId: "client-1",
        docType: "ID_COPY",
        extractionStatus: "done",
        extractionGeneration: "generation-id",
        validationResult: { isValid: true, matchScore: 100, mismatches: [] },
        validationScore: 100,
        // Every value identical to what is on file, plus a gender the client
        // lacks — so there IS something to apply, but the subject fingerprint
        // does not move and no evidence is at risk.
        extractionResult: {
          documentNumber: { value: verifiedClient.idNumber },
          firstName: { value: verifiedClient.firstName },
          surname: { value: verifiedClient.lastName },
          dateOfBirth: { value: "1990-01-01" },
          gender: { value: "MALE" },
        },
      })
      clientUpdateMock.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
        ...verifiedClient, ...data,
      }))

      const response = await apply({ documentId: "id-doc-1" })

      expect(response.status).toBe(200)
      expect(documentCountMock).not.toHaveBeenCalled()
      expect(clientUpdateMock).toHaveBeenCalled()
    })

    it("does not treat a truthy-but-not-true acknowledgement as consent", async () => {
      clientFindUniqueMock.mockResolvedValueOnce(verifiedClient)
      idCopyChangingFirstName()
      documentCountMock.mockResolvedValueOnce(2)

      const response = await apply({
        documentId: "id-doc-1",
        acknowledgeIdentityRevocation: "yes",
      })

      expect(response.status).toBe(409)
      expect(clientUpdateMock).not.toHaveBeenCalled()
    })

    // Bureau and AVS evidence are fingerprinted on identity too, over
    // DIFFERENT field sets — the bureau subject includes gender, which the
    // biometric subject does not. Warning about selfies alone would state a
    // loss list that is not the loss list, and a bureau re-pull costs money
    // and needs fresh consent.
    it("counts a stranded credit-bureau check for a gender-only change", async () => {
      clientFindUniqueMock.mockResolvedValueOnce({
        ...verifiedClient,
        gender: "FEMALE",
        kycStatus: "PENDING",
        kycVerificationMethod: null,
      })
      documentFindFirstMock.mockResolvedValueOnce({
        id: "id-doc-1",
        clientId: "client-1",
        docType: "ID_COPY",
        extractionStatus: "done",
        extractionGeneration: "generation-id",
        validationResult: { isValid: true, matchScore: 100, mismatches: [] },
        validationScore: 100,
        extractionResult: {
          documentNumber: { value: verifiedClient.idNumber },
          firstName: { value: verifiedClient.firstName },
          surname: { value: verifiedClient.lastName },
          dateOfBirth: { value: "1990-01-01" },
          gender: { value: "MALE" },
        },
      })
      bureauCountMock.mockResolvedValueOnce(1)

      const response = await apply({ documentId: "id-doc-1" })

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toContain("credit-bureau check")
      expect(body.error).toContain("fresh consent")
      expect(body.identityRevocation).toMatchObject({
        changedFields: ["gender"],
        bureauChecks: 1,
        // Gender is not in the biometric subject, so no selfie is at risk and
        // the selfie count must not even be taken.
        verifiedSelfies: 0,
        revokesVerifiedKyc: false,
      })
      expect(documentCountMock).not.toHaveBeenCalled()
      expect(clientUpdateMock).not.toHaveBeenCalled()
    })

    // A bank-tuple change moves the AVS subject and nothing else, and this
    // route already owns that case: it invalidates the verified bank statements
    // and audits it, without blocking. Correcting bank details from a bank
    // statement is the ordinary use of that document, so putting a confirmation
    // in front of it would break a routine workflow to restate a handled event.
    it("does not refuse a routine bank-detail correction", async () => {
      clientFindUniqueMock.mockResolvedValueOnce({
        ...verifiedClient,
        kycStatus: "PENDING",
        kycVerificationMethod: null,
      })
      avsCountMock.mockResolvedValue(3)

      const response = await apply({ documentId: "doc-1" })

      expect(response.status).toBe(200)
      // The guard must not even ask: nothing it governs has moved.
      expect(avsCountMock).not.toHaveBeenCalled()
      expect(documentCountMock).not.toHaveBeenCalled()
    })

    // But when identity DOES move, AVS is stranded too — the AVS subject
    // includes idNumber/firstName/lastName — so the loss list must say so.
    it("reports a stranded bank-account verification when identity moves", async () => {
      clientFindUniqueMock.mockResolvedValueOnce({
        ...verifiedClient,
        kycStatus: "PENDING",
        kycVerificationMethod: null,
      })
      idCopyChangingFirstName()
      avsCountMock.mockResolvedValueOnce(2)

      const response = await apply({ documentId: "id-doc-1" })

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toContain("bank-account verification")
      expect(body.identityRevocation).toMatchObject({ avsChecks: 2 })
    })

    // A check that never succeeded was not usable evidence, so naming it as a
    // loss overstates what this apply costs.
    it("ignores bureau and AVS checks that did not succeed", async () => {
      clientFindUniqueMock.mockResolvedValueOnce({
        ...verifiedClient,
        kycStatus: "PENDING",
        kycVerificationMethod: null,
      })
      idCopyChangingFirstName()

      await apply({ documentId: "id-doc-1" })

      expect(bureauCountMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ ok: true }) }),
      )
      expect(avsCountMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ passed: true }) }),
      )
    })

    it("records on the audit row that the revocation was acknowledged", async () => {
      clientFindUniqueMock.mockResolvedValueOnce(verifiedClient)
      idCopyChangingFirstName()
      documentFindManyMock.mockResolvedValueOnce([{ id: "selfie-verified" }])
      clientUpdateMock.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
        ...verifiedClient, ...data,
      }))

      const response = await apply({
        documentId: "id-doc-1",
        acknowledgeIdentityRevocation: true,
      })

      expect(response.status).toBe(200)
      const kycAudit = auditCreateMock.mock.calls.find(
        (call) => call[0].data.action === "KYC_STATUS_CHANGED",
      )?.[0].data
      // Without this an auditor cannot tell a warned, deliberate revocation
      // from one that nothing announced.
      expect(kycAudit.newValue).toMatchObject({ acknowledgedIdentityRevocation: true })
    })

    it("does not apply an SA ID the checksum flagged as misread", async () => {
      clientFindUniqueMock.mockResolvedValueOnce(verifiedClient)
      documentFindFirstMock.mockResolvedValueOnce({
        id: "id-doc-1",
        clientId: "client-1",
        docType: "ID_COPY",
        extractionStatus: "done",
        extractionGeneration: "generation-id",
        validationResult: { isValid: true, matchScore: 100, mismatches: [] },
        validationScore: 100,
        extractionResult: {
          // applyIdValidationPostProcessing flags a Luhn/length failure here.
          // That number feeds the bureau subject and the biometric subject.
          documentNumber: { value: "9001015000009", validated: false },
          firstName: { value: verifiedClient.firstName },
          surname: { value: verifiedClient.lastName },
          dateOfBirth: { value: "1990-01-01" },
        },
      })
      clientUpdateMock.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
        ...verifiedClient, ...data,
      }))

      const response = await apply({ documentId: "id-doc-1" })

      expect(response.status).toBe(200)
      const applied = (await response.json()).applied as string[]
      expect(applied).not.toContain("idNumber")
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.not.objectContaining({ idNumber: "9001015000009" }),
      }))
    })
  })

  // Re-applying the same verified bank statement must not invalidate it, or a
  // disbursement is blocked: the apply must not write back values that are not
  // new. The VLM can guess CHEQUE where the statement prints no product name and a staff
  // member has set SAVINGS by hand; and it writes the bank as printed
  // ("STANDARD BANK") where the staff edit form stores the SA_BANKS code
  // ("STANDARD_BANK"). Both read as a bank-detail change, and this route's
  // (correct) response to a bank-detail change is to un-verify the statement.
  describe("a re-apply of the same statement is not a bank-detail change", () => {
    const bankStatementExtracting = (
      extractionResult: Record<string, { value: unknown }>,
    ) => {
      documentFindFirstMock.mockImplementation((args: { where?: { docType?: string } }) =>
        Promise.resolve(args.where?.docType === "SELFIE" ? passingSelfie : {
          ...sourceBankDocument,
          extractionResult,
        }),
      )
      return applyBankStatement()
    }

    const onFile = (bankName: string | null) => {
      const row = { ...previousClient, bankName }
      clientFindUniqueMock.mockResolvedValue(row)
      // The update mock must spread the row the route actually read, or fields
      // the update stops mentioning revert to the default fixture and read as a
      // payout-tuple change that never happened.
      clientUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
      }))
    }

    it("keeps a staff-set accountType and reports that it did", async () => {
      const response = await bankStatementExtracting({
        bankName: { value: previousClient.bankName },
        accountNumber: { value: previousClient.bankAccountNumber },
        branchCode: { value: previousClient.bankBranchCode },
        accountType: { value: "CHEQUE" },
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.applied).not.toContain("accountType")
      expect(body.skipped).toEqual([{
        field: "accountType",
        record: "SAVINGS",
        extracted: "CHEQUE",
        reason: "record_set_by_staff",
      }])
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.not.objectContaining({ accountType: "CHEQUE" }),
      }))
      // Nothing moved, so no verified statement may be invalidated.
      expect(documentUpdateManyMock).not.toHaveBeenCalled()
    })

    it("applies an extracted accountType when the record has none", async () => {
      clientFindUniqueMock.mockResolvedValueOnce({ ...previousClient, accountType: null })

      const response = await bankStatementExtracting({
        bankName: { value: previousClient.bankName },
        accountNumber: { value: previousClient.bankAccountNumber },
        branchCode: { value: previousClient.bankBranchCode },
        accountType: { value: "SAVINGS" },
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.applied).toContain("accountType")
      expect(body.skipped).toBeUndefined()
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accountType: "SAVINGS" }),
      }))
    })

    it("treats the printed bank name and the stored bank code as one bank", async () => {
      onFile("STANDARD_BANK")

      const response = await bankStatementExtracting({
        bankName: { value: "Standard Bank" },
        accountNumber: { value: previousClient.bankAccountNumber },
        branchCode: { value: previousClient.bankBranchCode },
        accountType: { value: previousClient.accountType },
      })

      expect(response.status).toBe(200)
      // The record already names this bank, so nothing is written — not even
      // the identical string. A write here would move the payout tuple.
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.not.objectContaining({ bankName: expect.anything() }),
      }))
      expect(documentFindManyMock).not.toHaveBeenCalled()
      expect(documentUpdateManyMock).not.toHaveBeenCalled()
    })

    it("still invalidates the statement when the bank genuinely differs", async () => {
      const response = await bankStatementExtracting({
        bankName: { value: "Capitec Bank Limited" },
        accountNumber: { value: previousClient.bankAccountNumber },
        branchCode: { value: previousClient.bankBranchCode },
        accountType: { value: previousClient.accountType },
      })

      expect(response.status).toBe(200)
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ bankName: "CAPITEC" }),
      }))
      expect(documentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ verified: false }),
      }))
    })

    // bankName can be stored as the LABEL "First National Bank" while
    // extraction reads the same words off the statement. The apply must not be
    // refused 409 "decision evidence is bound to bankName" because only the
    // extracted side was canonicalised, and "FNB" never equals "First National Bank". Records hold the same spread:
    // CAPITEC and Capitec and Capitec Bank Limited and capitec, Standard Bank,
    // Discovery Bank, African Bank.
    it.each([
      ["First National Bank", "First National Bank"],
      ["Capitec", "CAPITEC BANK LIMITED"],
    ])("does not touch bankName when the record holds %s and the statement prints %s", async (
      record, extracted,
    ) => {
      onFile(record)
      // An APPROVED application is what turns a
      // phantom bank change into a hard refusal rather than a silent re-verify.
      applicationFindFirstMock.mockResolvedValue({ id: "app-1", reference: "APP-0001" })

      const response = await bankStatementExtracting({
        bankName: { value: extracted },
        accountNumber: { value: previousClient.bankAccountNumber },
        branchCode: { value: previousClient.bankBranchCode },
        accountType: { value: previousClient.accountType },
      })

      expect(response.status).toBe(200)
      // Not rewritten to the canonical code either: rewriting the record moves
      // the payout tuple, which is the invalidation this is meant to stop.
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.not.objectContaining({ bankName: expect.anything() }),
      }))
      expect(documentFindManyMock).not.toHaveBeenCalled()
      expect(documentUpdateManyMock).not.toHaveBeenCalled()
    })

    it("applies the extracted bank to a record that has none", async () => {
      onFile(null)

      const response = await bankStatementExtracting({
        bankName: { value: "Standard Bank" },
        accountNumber: { value: previousClient.bankAccountNumber },
        branchCode: { value: previousClient.bankBranchCode },
        accountType: { value: previousClient.accountType },
      })

      expect(response.status).toBe(200)
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ bankName: "STANDARD_BANK" }),
      }))
    })

    it("still invalidates when the statement names a different bank", async () => {
      onFile("FNB")

      const response = await bankStatementExtracting({
        bankName: { value: "Capitec Bank" },
        accountNumber: { value: previousClient.bankAccountNumber },
        branchCode: { value: previousClient.bankBranchCode },
        accountType: { value: previousClient.accountType },
      })

      expect(response.status).toBe(200)
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ bankName: "CAPITEC" }),
      }))
      expect(documentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ verified: false }),
      }))
    })

    // An unlisted bank has no code to canonicalise to; storing an invented one
    // would put a value in the record no picker can select.
    it("stores an unlisted bank exactly as the statement prints it", async () => {
      const response = await bankStatementExtracting({
        bankName: { value: "Sasfin Bank Limited" },
        accountNumber: { value: previousClient.bankAccountNumber },
        branchCode: { value: previousClient.bankBranchCode },
        accountType: { value: previousClient.accountType },
      })

      expect(response.status).toBe(200)
      expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ bankName: "Sasfin Bank Limited" }),
      }))
    })
  })

  it("rejects extraction from a document already deleted before the request", async () => {
    documentFindFirstMock.mockResolvedValueOnce(null)

    const response = await POST(new NextRequest(
      "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: "doc-deleted" }),
      },
    ), { params: Promise.resolve({ id: "client-1" }) })

    expect(response.status).toBe(404)
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("rejects a stale result while re-extraction is processing", async () => {
    documentFindFirstMock.mockResolvedValueOnce({
      id: "doc-1",
      clientId: "client-1",
      docType: "BANK_STATEMENT",
      extractionStatus: "processing",
      extractionGeneration: "generation-b",
      extractionResult: {
        bankName: { value: "FNB" },
        accountNumber: { value: "62000000000" },
      },
    })

    const response = await POST(new NextRequest(
      "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: "doc-1" }),
      },
    ), { params: Promise.resolve({ id: "client-1" }) })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "Extraction is not complete" })
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("rejects a done extraction that has no client-validation evidence", async () => {
    documentFindFirstMock.mockResolvedValueOnce({
      id: "doc-1",
      clientId: "client-1",
      docType: "BANK_STATEMENT",
      extractionStatus: "done",
      extractionGeneration: "generation-a",
      extractionResult: {
        bankName: { value: "FNB" },
        accountNumber: { value: "62000000000" },
      },
      validationResult: null,
      validationScore: null,
    })

    const response = await POST(new NextRequest(
      "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: "doc-1" }),
      },
    ), { params: Promise.resolve({ id: "client-1" }) })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "Document validation is not complete" })
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  // A payslip whose gross - deductions does not equal net has had a year-to-date
  // column read in place of the current month (lib/vlm-extract.ts flags this by
  // setting validated:false). Example: a payslip whose extracted YTD gross is R160,000.00
  // against a true monthly R40,000.00. Applying that writes a 4x
  // income into grossMonthlyIncome, which is the number affordability is decided
  // on — the flag has to block the write, not merely colour the UI orange.
  const applyFlaggedPayslip = (validated: boolean) => {
    documentFindFirstMock.mockImplementation((args: { where?: { docType?: string } }) =>
      Promise.resolve(args.where?.docType === "SELFIE" ? passingSelfie : {
        ...sourceBankDocument,
        docType: "PAYSLIP",
        extractionResult: {
          employerName: { value: "Northvale Mining (Pty) Ltd", validated: true },
          grossIncome: { value: 16000000, validated },
          netIncome: { value: 2700000, validated },
          totalDeductions: { value: 5600000, validated },
        },
      }),
    )
    return POST(new NextRequest(
      "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: "doc-1" }),
      },
    ), { params: Promise.resolve({ id: "client-1" }) })
  }

  it("does not write income the extractor flagged as failing the payslip totals check", async () => {
    const response = await applyFlaggedPayslip(false)

    expect(response.status).toBe(200)
    const applied = clientUpdateMock.mock.calls[0]?.[0]?.data ?? {}
    expect(applied).not.toHaveProperty("grossMonthlyIncome")
    expect(applied).not.toHaveProperty("monthlyIncome")
    // The unflagged field on the same document still applies.
    expect(applied).toMatchObject({ employerName: "Northvale Mining (Pty) Ltd" })
  })

  it("writes income from the same payslip once the totals reconcile", async () => {
    const response = await applyFlaggedPayslip(true)

    expect(response.status).toBe(200)
    expect(clientUpdateMock.mock.calls[0]?.[0]?.data).toMatchObject({
      grossMonthlyIncome: 16000000,
      monthlyIncome: 2700000,
    })
  })

  it("takes the client lock before source and composite-evidence reads", async () => {
    const response = await POST(new NextRequest(
      "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: "doc-1" }),
      },
    ), { params: Promise.resolve({ id: "client-1" }) })

    expect(response.status).toBe(200)
    // Source read + latest-selfie read + the in-person blocking-candidate
    // probe added by readCompositeKycState.
    expect(documentFindFirstMock).toHaveBeenCalledTimes(3)
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      documentFindFirstMock.mock.invocationCallOrder[0],
    )
  })

  it("keeps verification intact when the extracted payout tuple is unchanged", async () => {
    const onFile = {
      // Spread the real row: Client.idNumber/firstName/lastName are NOT NULL in
      // the schema, and the subject fingerprints read them. A fixture missing
      // them is not a client this route can ever be handed.
      ...previousClient,
      bankName: "FNB",
      bankAccountNumber: "62000000000",
      bankBranchCode: "250655",
      accountType: "CHEQUE" as const,
    }
    clientFindUniqueMock.mockResolvedValueOnce(onFile)
    // The update mock must spread the row the route actually read. Spreading
    // the default fixture instead makes fields the update does not mention
    // revert to it, which reads as a payout-tuple change that never happened.
    clientUpdateMock.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      ...onFile,
      ...data,
    }))

    const response = await POST(new NextRequest(
      "https://staging.acme-lending.example/api/clients/client-1/apply-extraction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: "doc-1" }),
      },
    ), { params: Promise.resolve({ id: "client-1" }) })

    expect(response.status).toBe(200)
    expect(documentFindManyMock).not.toHaveBeenCalled()
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(auditCreateMock.mock.calls[0][0].data.newValue)
      .not.toHaveProperty("bankEvidenceRevocation")
  })
})
