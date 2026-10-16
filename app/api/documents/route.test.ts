import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"

const logAuditMock = vi.fn()

const getDocumentCallerMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const documentCreateMock = vi.fn()
const documentFindFirstMock = vi.fn()
const documentUpdateManyMock = vi.fn()
const queryRawMock = vi.fn()
const transactionMock = vi.fn()
const applicationFindFirstMock = vi.fn()
const saveFileMock = vi.fn()
const deleteFileMock = vi.fn()
const extractDocumentDataMock = vi.fn()
const validateDocumentAgainstClientMock = vi.fn()
const readStatementInBackgroundMock = vi.fn()
const recomputeClientApplicationsMock = vi.fn()

const tx = {
  $queryRaw: (query: unknown) => queryRawMock(query),
  clientDocument: {
    create: (args: unknown) => documentCreateMock(args),
    findFirst: (args: unknown) => documentFindFirstMock(args),
    updateMany: (args: unknown) => documentUpdateManyMock(args),
  },
  client: {},
}

const reprojectKycMock = vi.fn()
const readKycBeforeMock = vi.fn()
vi.mock("@/lib/kyc/id-upload-projection.server", () => ({
  reprojectKycAfterIdUpload: (...args: unknown[]) => reprojectKycMock(...args),
  readKycBeforeIdUpload: (...args: unknown[]) => readKycBeforeMock(...args),
}))

vi.mock("@/lib/document-auth", () => ({
  getDocumentCaller: () => getDocumentCallerMock(),
  ALLOWED_MIME_TYPES: ["image/png", "application/pdf"],
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  VALID_DOC_TYPES: ["ID_COPY", "SELFIE", "BANK_STATEMENT", "PAYSLIP", "OTHER"],
  MAGIC_BYTE_PREFIX: 8,
  matchesMagic: () => true,
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    cb: (tenant: { id: string }) => Promise<unknown>,
  ) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: {
      findUnique: (args: unknown) => clientFindUniqueMock(args),
    },
    clientDocument: {
      create: (args: unknown) => documentCreateMock(args),
    },
    loanApplication: {
      findFirst: (args: unknown) => applicationFindFirstMock(args),
    },
    $transaction: (cb: (client: typeof tx) => Promise<unknown>, options?: unknown) => transactionMock(cb, options),
  },
}))
vi.mock("@/lib/storage", () => ({
  saveFile: (...args: unknown[]) => saveFileMock(...args),
  deleteFile: (...args: unknown[]) => deleteFileMock(...args),
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

const auditDocumentAccessRefusalMock = vi.fn()
vi.mock("@/lib/audit-refusals", () => ({
  auditDocumentAccessRefusal: (...args: unknown[]) => auditDocumentAccessRefusalMock(...args),
  auditRefusal: vi.fn(),
}))
vi.mock("@/lib/audit", () => ({
  logAuditStrict: (...args: unknown[]) => logAuditMock(...args),
  AuditAction: { DOCUMENT_DECRYPTED_AT_INTAKE: "DOCUMENT_DECRYPTED_AT_INTAKE" },
}))

import { POST } from "./route"
import { decryptPdfIfEncrypted } from "@/lib/documents/pdf-decrypt"
import { countIncrementalUpdates } from "@/lib/statement-analysis/pdf-tools"

// Deliberately NOT mocked: a mocked decryptor cannot prove a PDF actually
// opens, which is the whole point of the intake change.
const ENCRYPTED_PDF = readFileSync(
  path.join(process.cwd(), "lib/documents/__fixtures__/encrypted-sample.pdf"),
)
const FIXTURE_ID_NUMBER = "1234567890123"

function pdfRequest(bytes: Buffer) {
  const form = new FormData()
  form.set("file", new File([new Uint8Array(bytes)], "statement.pdf", {
    type: "application/pdf",
  }))
  form.set("docType", "BANK_STATEMENT")
  form.set("clientId", "client-1")
  return new Request("https://staging.acme-lending.example/api/documents", {
    method: "POST",
    body: form,
  })
}

function request(docType = "ID_COPY") {
  const form = new FormData()
  form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "id.png", {
    type: "image/png",
  }))
  form.set("docType", docType)
  form.set("clientId", "client-1")
  return new Request("https://staging.acme-lending.example/api/documents", {
    method: "POST",
    body: form,
  })
}

describe("POST /api/documents", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getDocumentCallerMock.mockResolvedValue({
      type: "staff",
      userId: "officer-1",
      role: "CREDIT_OFFICER",
      tenantId: "tenant-1",
    })
    clientFindUniqueMock.mockResolvedValue({ id: "client-1", popiaConsentGiven: false })
    documentCreateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "doc-1",
      ...data,
    }))
    documentFindFirstMock.mockResolvedValue({ id: "doc-1" })
    documentUpdateManyMock.mockResolvedValue({ count: 1 })
    queryRawMock.mockResolvedValue([{ lockResult: "" }])
    // Default: no approved-but-unsigned application, so no warning is attached.
    applicationFindFirstMock.mockResolvedValue(null)
    transactionMock.mockImplementation((cb: (client: typeof tx) => Promise<unknown>) => cb(tx))
    saveFileMock.mockResolvedValue({ storagePath: "tenant-1/client-1/id.png", fileSize: 4 })
    extractDocumentDataMock.mockResolvedValue({
      ok: true,
      data: { documentNumber: { value: "9001015000086" } },
    })
    validateDocumentAgainstClientMock.mockResolvedValue({
      isValid: true,
      matchScore: 100,
      mismatches: [],
      matches: ["SA ID Number"],
    })
  })

  it("stores a password-protected PDF decrypted, bound to the stored bytes", async () => {
    clientFindUniqueMock.mockResolvedValue({
      id: "client-1",
      popiaConsentGiven: false,
      idNumber: FIXTURE_ID_NUMBER,
    })

    const res = await POST(pdfRequest(ENCRYPTED_PDF) as never)
    expect(res.status).toBe(201)

    const storedBytes = saveFileMock.mock.calls[0][0] as Buffer
    // Not merely "decrypt was called" — the bytes that reached storage must be
    // the decrypted ones, and must open with no password at all.
    expect(storedBytes.equals(ENCRYPTED_PDF)).toBe(false)
    expect(await decryptPdfIfEncrypted(storedBytes, [])).toEqual({
      ok: true,
      bytes: storedBytes,
      decrypted: false,
    })

    // The integrity binding must cover what is on disk, not what was uploaded.
    const created = documentCreateMock.mock.calls[0][0].data as Record<string, unknown>
    expect(created.contentSha256).toBe(sha256DocumentBytes(storedBytes))
    expect(created.contentSha256).not.toBe(sha256DocumentBytes(ENCRYPTED_PDF))
  })

  it("records the decryption in the audit trail", async () => {
    clientFindUniqueMock.mockResolvedValue({
      id: "client-1",
      popiaConsentGiven: false,
      idNumber: FIXTURE_ID_NUMBER,
    })

    await POST(pdfRequest(ENCRYPTED_PDF) as never)

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DOCUMENT_DECRYPTED_AT_INTAKE",
        entity: "ClientDocument",
        entityId: "doc-1",
        // The rewrite erases appended revisions; the statement checks read this instead.
        newValue: expect.objectContaining({ originalIncrementalUpdates: countIncrementalUpdates(ENCRYPTED_PDF) }),
      }),
    )
  })

  // logAuditStrict, not logAudit: this row is the only record that the stored
  // bytes differ from what the client sent, so losing it silently is not an
  // acceptable outcome of a successful upload.
  it("fails the upload if the decryption cannot be audited", async () => {
    clientFindUniqueMock.mockResolvedValue({
      id: "client-1",
      popiaConsentGiven: false,
      idNumber: FIXTURE_ID_NUMBER,
    })
    logAuditMock.mockRejectedValue(new Error("audit table unavailable"))

    const res = await POST(pdfRequest(ENCRYPTED_PDF) as never)

    expect(res.status).toBe(500)
  })

  it("rejects a password-protected PDF nothing can open, storing nothing", async () => {
    clientFindUniqueMock.mockResolvedValue({
      id: "client-1",
      popiaConsentGiven: false,
      idNumber: "0000000000000",
    })

    const res = await POST(pdfRequest(ENCRYPTED_PDF) as never)
    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("password-protected"),
    })
    // An unreadable document must not reach storage or the database at all.
    expect(saveFileMock).not.toHaveBeenCalled()
    expect(documentCreateMock).not.toHaveBeenCalled()
  })

  it("leaves an unencrypted upload byte-identical and unaudited", async () => {
    clientFindUniqueMock.mockResolvedValue({
      id: "client-1",
      popiaConsentGiven: false,
      idNumber: FIXTURE_ID_NUMBER,
    })
    const plain = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

    const res = await POST(request() as never)
    expect(res.status).toBe(201)

    const storedBytes = saveFileMock.mock.calls[0][0] as Buffer
    expect(storedBytes.equals(plain)).toBe(true)
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("re-projects the stored KYC status in the same transaction as an ID upload", async () => {
    // A consentless portal client: no extraction transaction muddies the count.
    getDocumentCallerMock.mockResolvedValue({
      type: "client",
      clientId: "client-1",
      email: "client@example.test",
    })
    const order: string[] = []
    queryRawMock.mockImplementation(async () => { order.push("lock"); return [{ lockResult: "" }] })
    documentCreateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      order.push("create")
      return { id: "doc-1", ...data }
    })
    const kycBefore = { id: "client-1", kycStatus: "VERIFIED" }
    readKycBeforeMock.mockImplementation(async () => { order.push("read-before"); return kycBefore })
    reprojectKycMock.mockImplementation(async () => { order.push("reproject") })

    const response = await POST(request("ID_COPY") as never)

    expect(response.status).toBe(201)
    expect(transactionMock).toHaveBeenCalledTimes(1)
    // The snapshot is taken BEFORE the insert: the insert can demote the
    // client by itself, and the audit row compares against this.
    expect(order).toEqual(["lock", "read-before", "create", "reproject"])
    expect(reprojectKycMock).toHaveBeenCalledWith(tx, {
      tenantId: "tenant-1",
      clientId: "client-1",
      documentId: "doc-1",
      before: kycBefore,
      actor: { type: "client", email: "client@example.test" },
    })
  })

  it("attributes a staff ID upload's re-projection to the staff user", async () => {
    const response = await POST(request("ID_COPY") as never)

    expect(response.status).toBe(201)
    expect(reprojectKycMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      clientId: "client-1",
      actor: { type: "staff", userId: "officer-1" },
    }))
  })

  it("fails the upload when the re-projection fails, so the document is not committed alone", async () => {
    reprojectKycMock.mockRejectedValue(new Error("audit table unavailable"))

    const response = await POST(request("ID_COPY") as never)

    expect(response.status).toBe(500)
    // The rolled-back upload leaves no orphaned file, and the transaction is
    // not left at Prisma's 5 s default while queued behind the evidence lock.
    expect(deleteFileMock).toHaveBeenCalledWith("tenant-1/client-1/id.png")
    expect(transactionMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxWait: expect.any(Number), timeout: expect.any(Number) }),
    )
  })

  it("keeps the stored file when the upload commits", async () => {
    const response = await POST(request("ID_COPY") as never)

    expect(response.status).toBe(201)
    expect(deleteFileMock).not.toHaveBeenCalled()
  })

  it("removes the stored file when a non-ID document row cannot be written", async () => {
    documentCreateMock.mockRejectedValue(new Error("database unavailable"))

    const response = await POST(request("PAYSLIP") as never)

    expect(response.status).toBe(500)
    expect(deleteFileMock).toHaveBeenCalledWith("tenant-1/client-1/id.png")
  })

  it("does not re-project for other document types", async () => {
    const response = await POST(request("PAYSLIP") as never)

    expect(response.status).toBe(201)
    expect(documentCreateMock).toHaveBeenCalledTimes(1)
    expect(reprojectKycMock).not.toHaveBeenCalled()
  })

  it("refuses SELFIE creation outside the serialized biometric workflow", async () => {
    const response = await POST(request("SELFIE") as never)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Selfies must be uploaded through the biometric verification workflow",
    })
    expect(clientFindUniqueMock).not.toHaveBeenCalled()
    expect(saveFileMock).not.toHaveBeenCalled()
    expect(documentCreateMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("claims a generation at creation and completes only that generation", async () => {
    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    const create = documentCreateMock.mock.calls[0][0]
    const generation = create.data.extractionGeneration
    expect(create.data).toEqual(expect.objectContaining({
      contentSha256: sha256DocumentBytes(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      ),
      extractionStatus: "processing",
      extractionGeneration: expect.stringMatching(/^[0-9a-f-]{36}$/),
      extractionStartedAt: expect.any(Date),
    }))

    await vi.waitFor(() => expect(documentUpdateManyMock).toHaveBeenCalledOnce())
    expect(documentFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        extractionStatus: "processing",
        extractionGeneration: generation,
      }),
    }))
    expect(documentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        extractionStatus: "processing",
        extractionGeneration: generation,
      }),
      data: expect.objectContaining({
        extractionStatus: "done",
        extractionStartedAt: null,
        validationScore: 100,
      }),
    }))
    expect(validateDocumentAgainstClientMock).toHaveBeenCalledWith(
      expect.any(Object),
      "ID_COPY",
      "client-1",
      tx,
    )
  })

  it("discards a completion after the generation has been superseded", async () => {
    documentFindFirstMock.mockResolvedValue(null)

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(documentFindFirstMock).toHaveBeenCalledOnce())
    expect(documentUpdateManyMock).not.toHaveBeenCalled()
    expect(validateDocumentAgainstClientMock).not.toHaveBeenCalled()
  })

  it("stores a consentless client upload as skipped without starting extraction", async () => {
    getDocumentCallerMock.mockResolvedValue({
      type: "client",
      clientId: "client-1",
      email: "client@test.invalid",
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    expect(documentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "skipped",
        extractionGeneration: null,
        extractionStartedAt: null,
      }),
    }))
    expect(extractDocumentDataMock).not.toHaveBeenCalled()
    // The ID upload's own transaction (document + KYC re-projection) is the
    // only one: no extraction transaction follows it.
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })

  it("reads a staff-uploaded bank statement for the credit checks", async () => {
    const response = await POST(request("BANK_STATEMENT") as never)

    expect(response.status).toBe(201)
    expect(readStatementInBackgroundMock).toHaveBeenCalledWith(expect.any(String), "doc-1", { onRead: expect.any(Function) })
  })

  it("raises a statement's findings on the client's applications once it is read", async () => {
    recomputeClientApplicationsMock.mockResolvedValue(undefined)
    await POST(request("BANK_STATEMENT") as never)
    const { onRead } = readStatementInBackgroundMock.mock.calls[0][2] as { onRead: () => Promise<unknown> }
    await onRead()
    expect(recomputeClientApplicationsMock).toHaveBeenCalledWith("tenant-1", "client-1")
  })

  it("recomputes the client's applications when a payslip's extraction completes, and a failure there does not fail the extraction", async () => {
    recomputeClientApplicationsMock.mockRejectedValue(new Error("db down"))
    await POST(request("PAYSLIP") as never)
    await vi.waitFor(() => expect(recomputeClientApplicationsMock).toHaveBeenCalledWith("tenant-1", "client-1"))
    const statuses = documentUpdateManyMock.mock.calls.map((c) => (c[0] as { data: { extractionStatus: string } }).data.extractionStatus)
    expect(statuses).toEqual(["done"])
  })

  it("does not recompute for an ID document's extraction", async () => {
    await POST(request("ID_COPY") as never)
    await vi.waitFor(() => expect(documentUpdateManyMock).toHaveBeenCalledOnce())
    expect(recomputeClientApplicationsMock).not.toHaveBeenCalled()
  })

  it("does not read a statement a consentless client uploaded, nor any other document type", async () => {
    await POST(request("ID_COPY") as never)
    getDocumentCallerMock.mockResolvedValue({ type: "client", clientId: "client-1", email: "client@test.invalid" })
    await POST(request("BANK_STATEMENT") as never)

    expect(readStatementInBackgroundMock).not.toHaveBeenCalled()
  })

  it("releases the processing lease when background extraction fails", async () => {
    extractDocumentDataMock.mockResolvedValueOnce({
      ok: false,
      error: "provider unavailable",
    })

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(documentUpdateManyMock).toHaveBeenCalledOnce())
    expect(documentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        extractionStartedAt: null,
        extractionError: "provider unavailable",
      }),
    }))
  })

  it("records validation failure instead of publishing unvalidated extraction data as done", async () => {
    validateDocumentAgainstClientMock.mockRejectedValueOnce(new Error("client lookup failed"))

    const response = await POST(request() as never)

    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(documentUpdateManyMock).toHaveBeenCalledOnce())
    expect(documentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extractionStatus: "failed",
        extractionStartedAt: null,
        extractionError: "Client validation failed: client lookup failed",
        validationMismatch: true,
        validationScore: null,
      }),
    }))
  })

  // Staff who have a signed PDF back from a client reach for the document
  // uploader, because it is the upload they know. It stores the file as an
  // ordinary client document and reports success — nothing records it against
  // the loan, and disbursement keeps refusing for a reason that reads like a
  // system fault.
  it("warns that a loose upload is NOT the recorded signed agreement", async () => {
    applicationFindFirstMock.mockResolvedValue({
      id: "app-1",
      reference: "APP-TEST-0001",
    })

    const response = await POST(request("OTHER") as never)

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.signedAgreementWarning).toMatchObject({
      applicationId: "app-1",
      reference: "APP-TEST-0001",
    })
    expect(body.signedAgreementWarning.message).toMatch(/not recorded as the signed credit agreement/i)
    expect(body.signedAgreementWarning.message).toMatch(/Upload and Record Signed Packet/i)
  })

  // The remedy names a control that lives ONLY on the staff Credit Agreement
  // panel. The portal offers "OTHER" as a client-selectable type, so without
  // this scoping a consumer mid-signing-ceremony is instructed to perform a
  // staff action they have no UI for.
  it("never sends the staff remedy to a portal client", async () => {
    getDocumentCallerMock.mockResolvedValue({
      type: "client",
      clientId: "client-1",
      tenantId: "tenant-1",
    })
    applicationFindFirstMock.mockResolvedValue({
      id: "app-1",
      reference: "APP-TEST-0001",
    })

    const response = await POST(request("OTHER") as never)

    expect(response.status).toBe(201)
    expect((await response.json()).signedAgreementWarning).toBeUndefined()
    // The lookup must not even run for a client — no staff-only state is built.
    expect(applicationFindFirstMock).not.toHaveBeenCalled()
  })

  // The document IS stored. Failing the request would tell the caller to
  // retry, creating a second ClientDocument row for the same file — on the
  // exact path this warning exists to make safer.
  it("still returns 201 when the warning lookup itself throws", async () => {
    applicationFindFirstMock.mockRejectedValue(new Error("db unavailable"))

    const response = await POST(request("OTHER") as never)

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.id).toBe("doc-1")
    expect(body.signedAgreementWarning).toBeUndefined()
  })

  it("does not warn when the client has no approved unsigned application", async () => {
    applicationFindFirstMock.mockResolvedValue(null)

    const response = await POST(request("OTHER") as never)

    expect(response.status).toBe(201)
    expect((await response.json()).signedAgreementWarning).toBeUndefined()
  })

  // Core KYC uploads are the normal, correct use of this route. Warning on
  // those would train staff to dismiss the banner that matters.
  it("does not warn on a core KYC upload even with an unsigned agreement pending", async () => {
    applicationFindFirstMock.mockResolvedValue({
      id: "app-1",
      reference: "APP-TEST-0001",
    })

    const response = await POST(request("ID_COPY") as never)

    expect(response.status).toBe(201)
    expect((await response.json()).signedAgreementWarning).toBeUndefined()
    // The application lookup must not even run for a core KYC type.
    expect(applicationFindFirstMock).not.toHaveBeenCalled()
  })

  describe("a read-only role", () => {
    it("refuses READONLY with 403 before reading the body, storing nothing, and audits it", async () => {
      getDocumentCallerMock.mockResolvedValue({
        type: "staff",
        userId: "viewer-1",
        role: "READONLY",
        tenantId: "tenant-1",
      })
      const req = request("BANK_STATEMENT")

      const response = await POST(req as never)

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: "Your role can view documents but not change them." })
      expect(req.bodyUsed).toBe(false)
      expect(saveFileMock).not.toHaveBeenCalled()
      expect(documentCreateMock).not.toHaveBeenCalled()
      expect(transactionMock).not.toHaveBeenCalled()
      expect(extractDocumentDataMock).not.toHaveBeenCalled()
      expect(readStatementInBackgroundMock).not.toHaveBeenCalled()
      expect(recomputeClientApplicationsMock).not.toHaveBeenCalled()
      expect(auditDocumentAccessRefusalMock).toHaveBeenCalledWith(expect.objectContaining({
        documentId: "upload",
        reason: "document_write_read_only_role",
        status: 403,
        tenantId: "tenant-1",
        actorUserId: "viewer-1",
        detail: { action: "upload", role: "READONLY" },
      }))
    })

    it.each(["COLLECTIONS_OFFICER", "INSURANCE_OFFICER"])("still lets %s upload", async (role) => {
      getDocumentCallerMock.mockResolvedValue({ type: "staff", userId: "staff-1", role, tenantId: "tenant-1" })

      const response = await POST(request("PAYSLIP") as never)

      expect(response.status).toBe(201)
      expect(documentCreateMock).toHaveBeenCalled()
      expect(auditDocumentAccessRefusalMock).not.toHaveBeenCalled()
    })

    it("still lets a portal client upload their own document", async () => {
      getDocumentCallerMock.mockResolvedValue({ type: "client", clientId: "client-1", email: "client@example.test" })

      const response = await POST(request("PAYSLIP") as never)

      expect(response.status).toBe(201)
      expect(auditDocumentAccessRefusalMock).not.toHaveBeenCalled()
    })
  })
})
