import { beforeEach, describe, expect, it, vi } from "vitest"

const getDocumentCallerMock = vi.fn()
const scopeFindFirstMock = vi.fn()
const documentFindFirstMock = vi.fn()
const documentUpdateManyMock = vi.fn()
const accessCreateMock = vi.fn()
const queryRawMock = vi.fn()
const transactionMock = vi.fn()
const readFileMock = vi.fn()
const extractDocumentDataMock = vi.fn()
const validateDocumentAgainstClientMock = vi.fn()
const readStatementInBackgroundMock = vi.fn()
const recomputeClientApplicationsMock = vi.fn()

const tx = {
  $queryRaw: (query: unknown) => queryRawMock(query),
  clientDocument: {
    findFirst: (args: unknown) => documentFindFirstMock(args),
    updateMany: (args: unknown) => documentUpdateManyMock(args),
  },
  documentAccessLog: {
    create: (args: unknown) => accessCreateMock(args),
  },
  client: {},
}

const auditDocumentAccessRefusalMock = vi.fn()
vi.mock("@/lib/audit-refusals", () => ({
  auditDocumentAccessRefusal: (...args: unknown[]) => auditDocumentAccessRefusalMock(...args),
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
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: {
      findFirst: (args: unknown) => scopeFindFirstMock(args),
    },
    $transaction: (cb: (client: typeof tx) => Promise<unknown>) => transactionMock(cb),
  },
}))
vi.mock("@/lib/storage", () => ({
  readFile: (path: string) => readFileMock(path),
}))
vi.mock("@/lib/vlm-extract", () => ({
  extractDocumentData: (args: unknown) => extractDocumentDataMock(args),
}))
vi.mock("@/lib/credit-checks/recompute", () => ({
  recomputeClientApplications: (...args: unknown[]) => recomputeClientApplicationsMock(...args),
}))
vi.mock("@/lib/statement-analysis/persist", () => ({
  readStatementInBackground: (...args: unknown[]) => readStatementInBackgroundMock(...args),
}))
vi.mock("@/lib/ocr/documentValidationService", () => ({
  validateDocumentAgainstClient: (...args: unknown[]) => validateDocumentAgainstClientMock(...args),
}))

import { POST } from "./route"

const lockedDocument = {
  id: "doc-1",
  clientId: "client-1",
  storagePath: "tenant-1/client-1/document.pdf",
  mimeType: "application/pdf",
  docType: "BANK_STATEMENT",
  extractionStatus: "done",
  extractionGeneration: "generation-a",
  extractionStartedAt: null,
  client: { popiaConsentGiven: true },
}

function request() {
  return new Request("https://staging.acme-lending.example/api/documents/doc-1/extract", {
    method: "POST",
  })
}

describe("POST /api/documents/[id]/extract", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getDocumentCallerMock.mockResolvedValue({
      type: "staff",
      userId: "officer-1",
      role: "CREDIT_OFFICER",
      tenantId: "tenant-1",
    })
    scopeFindFirstMock.mockResolvedValue({ clientId: "client-1" })
    documentFindFirstMock
      .mockResolvedValueOnce(lockedDocument)
      .mockResolvedValueOnce({ id: "doc-1" })
    documentUpdateManyMock.mockResolvedValue({ count: 1 })
    accessCreateMock.mockResolvedValue({ id: "access-1" })
    queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
    transactionMock.mockImplementation((cb: (client: typeof tx) => Promise<unknown>) => cb(tx))
    readFileMock.mockResolvedValue(Buffer.from("document"))
    extractDocumentDataMock.mockResolvedValue({
      ok: true,
      data: { accountNumber: { value: "62000000000" } },
    })
    validateDocumentAgainstClientMock.mockResolvedValue({
      isValid: true,
      matchScore: 100,
      mismatches: [],
      matches: ["bankAccountNumber"],
    })
  })

  it("clears stale evidence and completes only the claimed generation", async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(200)
    expect(queryRawMock).toHaveBeenCalledTimes(2)
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      documentFindFirstMock.mock.invocationCallOrder[0],
    )

    const processingUpdate = documentUpdateManyMock.mock.calls[0][0]
    const generation = processingUpdate.data.extractionGeneration
    expect(generation).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    expect(processingUpdate).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        extractionStatus: "done",
        extractionGeneration: "generation-a",
      }),
      data: expect.objectContaining({
        extractionStatus: "processing",
        extractionGeneration: generation,
        extractionStartedAt: expect.any(Date),
        extractionResult: expect.anything(),
        extractionError: null,
        validationResult: expect.anything(),
        validationMismatch: false,
        validationScore: null,
      }),
    }))
    expect(accessCreateMock).toHaveBeenCalledWith({
      data: {
        documentId: "doc-1",
        accessorType: "staff",
        accessorId: "officer-1",
        action: "extract",
      },
    })

    const completionUpdate = documentUpdateManyMock.mock.calls[1][0]
    expect(completionUpdate).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        extractionStatus: "processing",
        extractionGeneration: generation,
      }),
      data: expect.objectContaining({
        extractionStatus: "done",
        extractionStartedAt: null,
        extractionError: null,
        validationMismatch: false,
        validationScore: 100,
      }),
    }))
    expect(validateDocumentAgainstClientMock).toHaveBeenCalledWith(
      expect.any(Object),
      "BANK_STATEMENT",
      "client-1",
      tx,
    )
  })

  it("re-reads a bank statement for the credit checks on a manual re-extract", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "doc-1" }) })

    expect(response.status).toBe(200)
    // A re-extract retries a read that failed, and raises its findings once read.
    expect(readStatementInBackgroundMock).toHaveBeenCalledWith(expect.any(String), "doc-1", { retryFailed: true, actorUserId: "officer-1", onRead: expect.any(Function) })
  })

  it("lets only credit staff discard a failed read when re-extracting", async () => {
    // READONLY may not extract at all; a writing role below credit staff
    // still re-reads but may not discard the failed read.
    getDocumentCallerMock.mockResolvedValue({ type: "staff", userId: "co-1", role: "COLLECTIONS_OFFICER", tenantId: "tenant-1" })
    await POST(request(), { params: Promise.resolve({ id: "doc-1" }) })
    expect(readStatementInBackgroundMock).toHaveBeenCalledWith(expect.any(String), "doc-1", expect.objectContaining({ retryFailed: false }))
  })

  it("recomputes the client's applications after re-extracting a payslip", async () => {
    documentFindFirstMock.mockReset()
    documentFindFirstMock
      .mockResolvedValueOnce({ ...lockedDocument, docType: "PAYSLIP" })
      .mockResolvedValueOnce({ id: "doc-1" })
    recomputeClientApplicationsMock.mockResolvedValue(undefined)
    const response = await POST(request(), { params: Promise.resolve({ id: "doc-1" }) })
    expect(response.status).toBe(200)
    expect(recomputeClientApplicationsMock).toHaveBeenCalledWith(expect.any(String), "client-1")
    expect(readStatementInBackgroundMock).not.toHaveBeenCalled()
  })

  it("refuses to mutate a retained credit agreement", async () => {
    documentFindFirstMock.mockReset().mockResolvedValueOnce({
      ...lockedDocument,
      docType: "CREDIT_AGREEMENT",
      extractionStatus: "skipped",
    })

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Credit-agreement records are immutable and cannot be re-extracted",
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(accessCreateMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(extractDocumentDataMock).not.toHaveBeenCalled()
  })

  it("preserves the retained debit-mandate extraction refusal", async () => {
    documentFindFirstMock.mockReset().mockResolvedValueOnce({
      ...lockedDocument,
      docType: "DEBIT_MANDATE",
      extractionStatus: "skipped",
    })

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Signed debit-mandate records are immutable and cannot be re-extracted",
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(accessCreateMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(extractDocumentDataMock).not.toHaveBeenCalled()
  })

  it("refuses to re-extract locked Form 20 statutory evidence", async () => {
    documentFindFirstMock.mockReset().mockResolvedValueOnce({
      ...lockedDocument,
      docType: "FORM_20_PRE_AGREEMENT",
      extractionStatus: "skipped",
    })

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Form 20/PASQ is locked statutory evidence; complete it through the signing and acknowledgement workflow",
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(accessCreateMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(extractDocumentDataMock).not.toHaveBeenCalled()
  })

  it("refuses locked Form 20 before checking whether storage is intact", async () => {
    documentFindFirstMock.mockReset().mockResolvedValueOnce({
      ...lockedDocument,
      docType: "FORM_20_PRE_AGREEMENT",
      storagePath: null,
      extractionStatus: "skipped",
    })

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Form 20/PASQ is locked statutory evidence; complete it through the signing and acknowledgement workflow",
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(accessCreateMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(extractDocumentDataMock).not.toHaveBeenCalled()
  })

  it("refuses generic re-extraction of biometric selfie evidence", async () => {
    documentFindFirstMock.mockReset().mockResolvedValueOnce({
      ...lockedDocument,
      docType: "SELFIE",
    })

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Selfie biometric evidence can only be refreshed by uploading a new selfie",
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(accessCreateMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(extractDocumentDataMock).not.toHaveBeenCalled()
  })

  it("does not expose the previous result while an extraction is processing", async () => {
    documentFindFirstMock.mockReset().mockResolvedValueOnce({
      ...lockedDocument,
      extractionStatus: "processing",
      extractionGeneration: "generation-b",
      extractionStartedAt: new Date(),
    })

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Document extraction is already in progress",
    })
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(accessCreateMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(extractDocumentDataMock).not.toHaveBeenCalled()
  })

  it("reclaims an abandoned processing generation after its lease expires", async () => {
    const abandonedAt = new Date(Date.now() - 16 * 60 * 1000)
    documentFindFirstMock
      .mockReset()
      .mockResolvedValueOnce({
        ...lockedDocument,
        extractionStatus: "processing",
        extractionGeneration: "abandoned-generation",
        extractionStartedAt: abandonedAt,
      })
      .mockResolvedValueOnce({ id: "doc-1" })

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(200)
    const reclaim = documentUpdateManyMock.mock.calls[0][0]
    expect(reclaim.where).toEqual(expect.objectContaining({
      extractionStatus: "processing",
      extractionGeneration: "abandoned-generation",
      extractionStartedAt: abandonedAt,
    }))
    expect(reclaim.data).toEqual(expect.objectContaining({
      extractionStatus: "processing",
      extractionGeneration: expect.not.stringMatching(/^abandoned-generation$/),
      extractionStartedAt: expect.any(Date),
    }))
  })

  it("reclaims a legacy processing generation that has no lease timestamp", async () => {
    documentFindFirstMock
      .mockReset()
      .mockResolvedValueOnce({
        ...lockedDocument,
        extractionStatus: "processing",
        extractionGeneration: "legacy-generation",
        extractionStartedAt: null,
      })
      .mockResolvedValueOnce({ id: "doc-1" })

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(200)
    expect(documentUpdateManyMock.mock.calls[0][0].where).toEqual(expect.objectContaining({
      extractionGeneration: "legacy-generation",
      extractionStartedAt: null,
    }))
  })

  it("rejects an out-of-order completion that no longer owns the generation", async () => {
    documentFindFirstMock
      .mockReset()
      .mockResolvedValueOnce(lockedDocument)
      .mockResolvedValueOnce(null)

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "Document extraction was superseded" })
    expect(documentUpdateManyMock).toHaveBeenCalledOnce()
    expect(documentUpdateManyMock.mock.calls[0][0].data.extractionStatus).toBe("processing")
  })

  it("fails only the generation that raised a provider error", async () => {
    extractDocumentDataMock.mockRejectedValueOnce(new Error("provider timeout"))

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(500)
    expect(documentUpdateManyMock).toHaveBeenCalledTimes(2)
    const processingUpdate = documentUpdateManyMock.mock.calls[0][0]
    const failureUpdate = documentUpdateManyMock.mock.calls[1][0]
    expect(failureUpdate.where).toEqual(expect.objectContaining({
      extractionStatus: "processing",
      extractionGeneration: processingUpdate.data.extractionGeneration,
    }))
    expect(failureUpdate.data).toEqual(expect.objectContaining({
      extractionStatus: "failed",
      extractionStartedAt: null,
      extractionError: "Error: provider timeout",
    }))
  })

  it("fails the claimed generation when client validation cannot produce a decision", async () => {
    validateDocumentAgainstClientMock.mockRejectedValueOnce(new Error("client lookup failed"))

    const response = await POST(request(), {
      params: Promise.resolve({ id: "doc-1" }),
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      ok: false,
      error: "Client validation failed: client lookup failed",
    })
    expect(documentUpdateManyMock).toHaveBeenCalledTimes(2)
    const processingUpdate = documentUpdateManyMock.mock.calls[0][0]
    expect(documentUpdateManyMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        extractionStatus: "processing",
        extractionGeneration: processingUpdate.data.extractionGeneration,
      }),
      data: expect.objectContaining({
        extractionStatus: "failed",
        extractionStartedAt: null,
        extractionError: "Client validation failed: client lookup failed",
        validationMismatch: true,
        validationScore: null,
      }),
    }))
  })

  describe("a read-only role", () => {
    it("refuses READONLY with 403 before any read, claim, extraction or recompute, and audits it", async () => {
      getDocumentCallerMock.mockResolvedValue({
        type: "staff",
        userId: "viewer-1",
        role: "READONLY",
        tenantId: "tenant-1",
      })

      const response = await POST(request(), { params: Promise.resolve({ id: "doc-1" }) })

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: "Your role can view documents but not change them." })
      expect(scopeFindFirstMock).not.toHaveBeenCalled()
      expect(transactionMock).not.toHaveBeenCalled()
      expect(documentUpdateManyMock).not.toHaveBeenCalled()
      expect(readFileMock).not.toHaveBeenCalled()
      expect(extractDocumentDataMock).not.toHaveBeenCalled()
      expect(readStatementInBackgroundMock).not.toHaveBeenCalled()
      expect(recomputeClientApplicationsMock).not.toHaveBeenCalled()
      expect(auditDocumentAccessRefusalMock).toHaveBeenCalledWith(expect.objectContaining({
        documentId: "doc-1",
        reason: "document_write_read_only_role",
        status: 403,
        tenantId: "tenant-1",
        actorUserId: "viewer-1",
        detail: { action: "extract", role: "READONLY" },
      }))
    })

    it("still lets CREDIT_OFFICER extract", async () => {
      const response = await POST(request(), { params: Promise.resolve({ id: "doc-1" }) })

      expect(response.status).toBe(200)
      expect(extractDocumentDataMock).toHaveBeenCalled()
      expect(auditDocumentAccessRefusalMock).not.toHaveBeenCalled()
    })

    it("still lets COLLECTIONS_OFFICER extract, as merged in #120", async () => {
      getDocumentCallerMock.mockResolvedValue({
        type: "staff",
        userId: "collector-1",
        role: "COLLECTIONS_OFFICER",
        tenantId: "tenant-1",
      })

      const response = await POST(request(), { params: Promise.resolve({ id: "doc-1" }) })

      expect(response.status).toBe(200)
      expect(extractDocumentDataMock).toHaveBeenCalled()
    })
  })
})
