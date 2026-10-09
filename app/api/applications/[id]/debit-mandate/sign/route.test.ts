import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { sha256DebitMandateValue } from "@/lib/compliance/debit-mandate"

const {
  auth,
  applicationFindUnique,
  applicationFindFirst,
  tenantFindUnique,
  complianceFindUnique,
  transaction,
  verifyLockedCurrentAffordabilityApproval,
  verifyCurrentStoredDebitMandate,
  renderApplicationDebitMandatePdf,
  saveFileToManagedPath,
  deleteManagedFileStrict,
  managedStoragePath,
  documentCreate,
  complianceCreate,
  complianceUpdateMany,
  applicationUpdateMany,
  auditLogCreate,
  documentAccessLogCreate,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  applicationFindUnique: vi.fn(),
  applicationFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
  complianceFindUnique: vi.fn(),
  transaction: vi.fn(),
  verifyLockedCurrentAffordabilityApproval: vi.fn(),
  verifyCurrentStoredDebitMandate: vi.fn(),
  renderApplicationDebitMandatePdf: vi.fn(),
  saveFileToManagedPath: vi.fn(),
  deleteManagedFileStrict: vi.fn(),
  managedStoragePath: vi.fn(),
  documentCreate: vi.fn(),
  complianceCreate: vi.fn(),
  complianceUpdateMany: vi.fn(),
  applicationUpdateMany: vi.fn(),
  auditLogCreate: vi.fn(),
  documentAccessLogCreate: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    callback: (tenant: { id: string; name: string }) => unknown,
  ) => callback({ id: "tenant-1", name: "Staging Tenant" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: {
      findUnique: applicationFindUnique,
      findFirst: applicationFindFirst,
    },
    tenant: { findUnique: tenantFindUnique },
    complianceRecord: { findUnique: complianceFindUnique },
    $transaction: transaction,
  },
}))
vi.mock("@/lib/affordability/current-approval", () => ({
  verifyLockedCurrentAffordabilityApproval,
}))
vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  debitMandateApplicationArgs: {},
  verifyCurrentStoredDebitMandate,
  renderApplicationDebitMandatePdf,
}))
vi.mock("@/lib/storage", () => ({
  saveFileToManagedPath,
  deleteManagedFileStrict,
  managedStoragePath,
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_target, property) => String(property) }),
}))

const draftPdf = Buffer.from("%PDF-1.4 exact prepared mandate")
const signedPdf = Buffer.from("%PDF-1.4 signed mandate")
const draftDocumentSha256 = sha256DocumentBytes(draftPdf)
const signedDocumentSha256 = sha256DocumentBytes(signedPdf)
const preparedAt = new Date("2026-07-23T15:00:00.000Z")
const application = {
  id: "app-1",
  tenantId: "tenant-1",
  clientId: "client-1",
  reference: "APP-TEST",
  status: "APPROVED",
  repaymentMethod: "DEBIT_ORDER",
  updatedAt: new Date("2026-07-23T15:30:00.000Z"),
  agreementSignedAt: new Date("2026-07-23T14:00:00.000Z"),
  debitMandatePreparedAt: preparedAt,
  debitMandateDraftSha256: draftDocumentSha256,
  debitMandateEvidenceSha256: "e".repeat(64),
  debitMandateSignedAt: null,
  client: {
    firstName: "Casey",
    lastName: "Staging",
    idNumber: "9001016000082",
    phone: "0710000000",
    email: "casey@example.test",
  },
}
const preparation = {
  ok: true as const,
  application,
  draftDocumentSha256,
  evidenceSha256: "e".repeat(64),
  evidence: {
    collectionReference: "LN-app-1",
    bankDetailsSha256: "b".repeat(64),
    bankStatement: { documentId: "statement-1" },
  },
  bankDetails: {
    bankName: "FNB",
    branchCode: "250655",
    accountNumber: "123456789",
    accountType: "SAVINGS",
  },
  contract: {
    paymentTerms: {
      paymentFrequency: "MONTHLY",
      recurringDebitAmount: 150_000,
      firstDebitAmount: 156_900,
      firstDebitDate: new Date("2026-08-31T00:00:00.000Z"),
      firstDebitInitiationFee: 6_900,
    },
  },
}
const ctx = { params: Promise.resolve({ id: "app-1" }) }

function request(body: unknown) {
  return new NextRequest(
    "https://staging.example.test/api/applications/app-1/debit-mandate/sign",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.1",
        "user-agent": "vitest",
      },
      body: JSON.stringify(body),
    },
  )
}

describe("POST /api/applications/[id]/debit-mandate/sign", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-23T16:00:00.000Z"))
    auth.mockResolvedValue({
      user: { id: "client-1", email: "casey@example.test", role: "CLIENT" },
    })
    applicationFindUnique.mockResolvedValue(application)
    applicationFindFirst.mockResolvedValue(null)
    complianceFindUnique.mockResolvedValue(null)
    tenantFindUnique.mockResolvedValue({
      id: "tenant-1",
      config: { ncrNumber: "NCRCP00000" },
    })
    verifyLockedCurrentAffordabilityApproval.mockResolvedValue({ ok: true })
    verifyCurrentStoredDebitMandate.mockResolvedValue(preparation)
    renderApplicationDebitMandatePdf.mockReset()
    renderApplicationDebitMandatePdf
      .mockResolvedValueOnce(draftPdf)
      .mockResolvedValueOnce(signedPdf)
    saveFileToManagedPath.mockResolvedValue({
      storagePath: "/managed/debit-mandate-doc-1.pdf",
      fileSize: signedPdf.length,
    })
    managedStoragePath.mockReturnValue("/managed/debit-mandate-doc-1.pdf")
    deleteManagedFileStrict.mockResolvedValue(undefined)
    documentCreate.mockResolvedValue({ id: "doc-1" })
    complianceCreate.mockResolvedValue({ id: "staging-1" })
    complianceUpdateMany.mockResolvedValue({ count: 1 })
    applicationUpdateMany.mockResolvedValue({ count: 1 })
    auditLogCreate.mockResolvedValue({ id: "audit-1" })
    documentAccessLogCreate.mockResolvedValue({ id: "access-1" })
    transaction.mockImplementation(
      (callback: (tx: unknown) => unknown) => callback({
        loanApplication: {
          findUnique: applicationFindUnique,
          updateMany: applicationUpdateMany,
        },
        clientDocument: { create: documentCreate },
        complianceRecord: {
          create: complianceCreate,
          updateMany: complianceUpdateMany,
        },
        auditLog: { create: auditLogCreate },
        documentAccessLog: { create: documentAccessLogCreate },
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns 400 for malformed JSON instead of turning it into a 500", async () => {
    const malformed = new NextRequest(
      "https://staging.example.test/api/applications/app-1/debit-mandate/sign",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    )
    const { POST } = await import("./route")

    const response = await POST(malformed, ctx)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Invalid request body.",
      debitMandate: "invalid_body",
    })
    expect(transaction).not.toHaveBeenCalled()
  })

  it("requires the exact prepared document hash", async () => {
    const { POST } = await import("./route")

    const response = await POST(request({
      signature: "Casey Staging",
      draftDocumentSha256: "f".repeat(64),
    }), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(
      expect.objectContaining({ debitMandate: "draft_hash_changed" }),
    )
    expect(saveFileToManagedPath).not.toHaveBeenCalled()
  })

  it("returns 409 while an indexed signing lease is still active", async () => {
    complianceFindUnique.mockResolvedValueOnce({
      id: "staging-old",
      tenantId: "tenant-1",
      status: "PENDING",
      dueDate: new Date("2026-07-23T16:05:00.000Z"),
      data: {
        kind: "DEBIT_MANDATE_ARTIFACT",
        lifecycle: "STAGING",
        applicationId: "app-1",
        clientId: "client-1",
        documentId: "doc-old",
        documentSha256: "a".repeat(64),
        storagePath: "/managed/debit-mandate-old.pdf",
        fileSize: 123,
        signedAt: "2026-07-23T15:59:00.000Z",
        signatureSha256: "b".repeat(64),
        evidenceSha256: "c".repeat(64),
        stagedAt: "2026-07-23T15:59:00.000Z",
      },
    })
    const { POST } = await import("./route")

    const response = await POST(request({
      signature: "Casey Staging",
      draftDocumentSha256,
    }), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      debitMandate: "staging_in_progress",
    }))
    expect(transaction).not.toHaveBeenCalled()
    expect(deleteManagedFileStrict).not.toHaveBeenCalled()
  })

  it("claims, audits and removes an expired indexed artifact before retrying", async () => {
    complianceFindUnique.mockResolvedValueOnce({
      id: "staging-old",
      tenantId: "tenant-1",
      status: "PENDING",
      dueDate: new Date("2026-07-23T15:45:00.000Z"),
      data: {
        kind: "DEBIT_MANDATE_ARTIFACT",
        lifecycle: "STAGING",
        applicationId: "app-1",
        clientId: "client-1",
        documentId: "doc-old",
        documentSha256: "a".repeat(64),
        storagePath: "/managed/debit-mandate-old.pdf",
        fileSize: 123,
        signedAt: "2026-07-23T15:30:00.000Z",
        signatureSha256: "b".repeat(64),
        evidenceSha256: "c".repeat(64),
        stagedAt: "2026-07-23T15:30:00.000Z",
      },
    })
    const { POST } = await import("./route")

    const response = await POST(request({
      signature: "Casey Staging",
      draftDocumentSha256,
    }), ctx)

    expect(response.status).toBe(200)
    expect(deleteManagedFileStrict).toHaveBeenCalledWith(
      "/managed/debit-mandate-old.pdf",
    )
    expect(complianceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "staging-old",
        data: { path: ["lifecycle"], equals: "STAGING" },
      }),
      data: {
        data: expect.objectContaining({ lifecycle: "RECONCILING" }),
      },
    }))
    expect(complianceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "staging-old",
        data: { path: ["lifecycle"], equals: "RECONCILING" },
      }),
      data: expect.objectContaining({
        idempotencyKey: null,
        data: expect.objectContaining({ lifecycle: "FAILED" }),
      }),
    }))
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "DEBIT_MANDATE_ARTIFACT_STAGING_RECOVERY_STARTED",
      }),
    })
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "DEBIT_MANDATE_ARTIFACT_STAGING_FAILED",
      }),
    })
  })

  it("stores the exact signed PDF and auditable customer signature evidence", async () => {
    const { POST } = await import("./route")

    const response = await POST(request({
      signature: "Casey Staging",
      draftDocumentSha256,
    }), ctx)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      signedAt: "2026-07-23T16:00:00.000Z",
      documentId: "doc-1",
      documentSha256: signedDocumentSha256,
    })
    expect(verifyCurrentStoredDebitMandate).toHaveBeenCalledTimes(2)
    expect(complianceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        type: "DEBIT_MANDATE_ARTIFACT",
        referenceId: "app-1",
        idempotencyKey: "debit-mandate-artifact:tenant-1:app-1",
        status: "PENDING",
        data: expect.objectContaining({
          kind: "DEBIT_MANDATE_ARTIFACT",
          lifecycle: "STAGING",
          documentSha256: signedDocumentSha256,
          storagePath: "/managed/debit-mandate-doc-1.pdf",
        }),
      }),
      select: { id: true },
    })
    expect(documentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        clientId: "client-1",
        docType: "DEBIT_MANDATE",
        storagePath: "/managed/debit-mandate-doc-1.pdf",
        contentSha256: signedDocumentSha256,
        verified: true,
        verifiedAt: new Date("2026-07-23T16:00:00.000Z"),
        signatureState: "signed",
        signedAt: new Date("2026-07-23T16:00:00.000Z"),
        signedByIp: "192.0.2.1",
      }),
      select: { id: true },
    })
    expect(applicationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          debitMandateSignedAt: new Date("2026-07-23T16:00:00.000Z"),
          debitMandateSignedMethod: "portal",
          debitMandateSignedByIp: "192.0.2.1",
          debitMandateSignatureData: "Casey Staging",
          debitMandateSignatureSha256:
            sha256DebitMandateValue("Casey Staging"),
          debitMandateDocumentId: "doc-1",
          debitMandateDocumentSha256: signedDocumentSha256,
        },
      }),
    )
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "DEBIT_MANDATE_SIGNED",
          entityId: "app-1",
          newValue: expect.objectContaining({
            documentId: "doc-1",
            documentSha256: signedDocumentSha256,
            bankStatementDocumentId: "statement-1",
          }),
        }),
      }),
    )
    expect(documentAccessLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: "doc-1",
        accessorType: "client",
        accessorId: "client-1",
        action: "signed",
      }),
    })
    expect(complianceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "staging-1",
        idempotencyKey: "debit-mandate-artifact:tenant-1:app-1",
        status: "PENDING",
        data: { path: ["lifecycle"], equals: "STAGING" },
      }),
      data: expect.objectContaining({
        idempotencyKey: null,
        status: "COMPLETED",
        data: expect.objectContaining({ lifecycle: "COMPLETED" }),
      }),
    }))
  })

  it("maps an unreadable drawn-PNG payload to a 422 signature error", async () => {
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 1),
    ])
    renderApplicationDebitMandatePdf
      .mockReset()
      .mockResolvedValueOnce(draftPdf)
      .mockRejectedValueOnce(new Error("PNG decode failed"))
    const { POST } = await import("./route")

    const response = await POST(request({
      signature: `data:image/png;base64,${fakePng.toString("base64")}`,
      draftDocumentSha256,
    }), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "The drawn signature is not a readable PNG.",
      debitMandate: "signature_invalid",
    })
    expect(saveFileToManagedPath).not.toHaveBeenCalled()
  })

  it("retains the indexed artifact when commit reconciliation itself is unavailable", async () => {
    transaction
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback({
        complianceRecord: { create: complianceCreate },
        auditLog: { create: auditLogCreate },
      }))
      .mockRejectedValueOnce(new Error("ambiguous transaction result"))
    applicationFindFirst.mockRejectedValueOnce(new Error("database unavailable"))
    const { POST } = await import("./route")

    const response = await POST(request({
      signature: "Casey Staging",
      draftDocumentSha256,
    }), ctx)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: "The signing outcome could not be reconciled safely. The indexed artifact has been retained for recovery.",
      debitMandate: "commit_reconciliation_required",
    })
    expect(complianceCreate).toHaveBeenCalledOnce()
    expect(deleteManagedFileStrict).not.toHaveBeenCalled()
  })

  it("returns the committed signature after an ambiguous successful commit without deleting its PDF", async () => {
    transaction
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback({
        complianceRecord: { create: complianceCreate },
        auditLog: { create: auditLogCreate },
      }))
      .mockRejectedValueOnce(new Error("connection lost after commit"))
    applicationFindFirst.mockResolvedValueOnce({
      id: "app-1",
      debitMandateSignedAt: new Date("2026-07-23T16:00:00.000Z"),
    })
    const { POST } = await import("./route")

    const response = await POST(request({
      signature: "Casey Staging",
      draftDocumentSha256,
    }), ctx)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({
      documentSha256: signedDocumentSha256,
      reconciled: true,
    }))
    expect(deleteManagedFileStrict).not.toHaveBeenCalled()
  })

  it("surfaces cleanup failure and keeps the staging index for recovery", async () => {
    transaction
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback({
        complianceRecord: { create: complianceCreate },
        auditLog: { create: auditLogCreate },
      }))
      .mockRejectedValueOnce(new Error("transaction rolled back"))
    applicationFindFirst.mockResolvedValueOnce(null)
    deleteManagedFileStrict.mockRejectedValueOnce(new Error("permission denied"))
    const { POST } = await import("./route")

    const response = await POST(request({
      signature: "Casey Staging",
      draftDocumentSha256,
    }), ctx)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: "The failed signing artifact requires storage reconciliation.",
      debitMandate: "staging_reconciliation_required",
    })
    expect(complianceCreate).toHaveBeenCalledOnce()
    expect(deleteManagedFileStrict).toHaveBeenCalledWith(
      "/managed/debit-mandate-doc-1.pdf",
    )
  })
})
