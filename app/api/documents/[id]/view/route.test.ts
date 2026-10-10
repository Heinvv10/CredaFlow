import { beforeEach, describe, expect, it, vi } from "vitest"
import { GET } from "./route"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"

const {
  clientDocumentFindFirst,
  loanApplicationFindFirst,
  loanApplicationFindMany,
  auditLogFindFirst,
  documentAccessLogCreate,
  readFile,
  getDocumentCaller,
} = vi.hoisted(() => ({
  clientDocumentFindFirst: vi.fn(),
  loanApplicationFindFirst: vi.fn(),
  loanApplicationFindMany: vi.fn(),
  auditLogFindFirst: vi.fn(),
  documentAccessLogCreate: vi.fn(),
  readFile: vi.fn(),
  getDocumentCaller: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: { findFirst: clientDocumentFindFirst },
    loanApplication: { findFirst: loanApplicationFindFirst, findMany: loanApplicationFindMany },
    auditLog: { findFirst: auditLogFindFirst },
    documentAccessLog: { create: documentAccessLogCreate },
  },
}))

vi.mock("@/lib/storage", () => ({ readFile }))
vi.mock("@/lib/document-auth", () => ({ getDocumentCaller }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: Request,
    callback: (tenant: { id: string }) => unknown,
  ) => callback({ id: "tenant-1" }),
}))

const AGREEMENT_BYTES = Buffer.from("%PDF-1.4 immutable agreement")
const AGREEMENT_SHA256 = sha256DocumentBytes(AGREEMENT_BYTES)
const context = { params: Promise.resolve({ id: "agreement-doc-1" }) }

function request(download = false) {
  return new Request(
    `http://localhost/api/documents/agreement-doc-1/view${download ? "?download=1" : ""}`,
    { headers: { "user-agent": "vitest" } },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getDocumentCaller.mockResolvedValue({
    type: "client",
    clientId: "client-1",
    email: "client@example.test",
  })
  clientDocumentFindFirst.mockResolvedValue({
    id: "agreement-doc-1",
    tenantId: "tenant-1",
    clientId: "client-1",
    docType: "CREDIT_AGREEMENT",
    fileName: "credit-agreement-app-1.pdf",
    mimeType: "application/pdf",
    storagePath: "/agreements/app-1.pdf",
    contentSha256: AGREEMENT_SHA256,
    deletedAt: null,
  })
  loanApplicationFindFirst.mockResolvedValue({ id: "app-1" })
  loanApplicationFindMany.mockResolvedValue([{ id: "app-1" }])
  auditLogFindFirst.mockResolvedValue(null)
  documentAccessLogCreate.mockResolvedValue({ id: "access-1" })
  readFile.mockResolvedValue(AGREEMENT_BYTES)
})

describe("GET /api/documents/[id]/view agreement integrity", () => {
  it("serves only the exact application-bound agreement bytes", async () => {
    const response = await GET(request(true), context)

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(AGREEMENT_BYTES)
    expect(response.headers.get("content-disposition")).toContain("attachment")
    expect(loanApplicationFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        clientId: "client-1",
        agreementDocumentId: "agreement-doc-1",
        agreementDocumentSha256: AGREEMENT_SHA256,
      },
      select: { id: true },
    })
  })

  it("rejects altered agreement bytes", async () => {
    readFile.mockResolvedValue(Buffer.from("%PDF-1.4 altered"))

    const response = await GET(request(), context)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      agreementIntegrity: "content_mismatch",
    }))
  })

  it("rejects a legacy agreement with no byte hash", async () => {
    clientDocumentFindFirst.mockResolvedValue({
      id: "agreement-doc-1",
      clientId: "client-1",
      docType: "CREDIT_AGREEMENT",
      fileName: "credit-agreement-app-1.pdf",
      mimeType: "application/pdf",
      storagePath: "/agreements/app-1.pdf",
      contentSha256: null,
      deletedAt: null,
    })

    const response = await GET(request(), context)

    expect(response.status).toBe(422)
    expect(loanApplicationFindFirst).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it("rejects an agreement whose application points to another artifact", async () => {
    loanApplicationFindFirst.mockResolvedValue(null)

    const response = await GET(request(), context)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      agreementIntegrity: "application_binding_mismatch",
    }))
    expect(readFile).not.toHaveBeenCalled()
  })

  it("serves a retained historical version only when a generation/backfill audit binds the same ID and hash", async () => {
    loanApplicationFindFirst.mockResolvedValue(null)
    auditLogFindFirst.mockResolvedValue({ id: "audit-generation-1" })

    const response = await GET(request(), context)

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(AGREEMENT_BYTES)
    expect(auditLogFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        action: {
          in: ["AGREEMENT_GENERATED", "AGREEMENT_INTEGRITY_BACKFILLED"],
        },
        entity: "LoanApplication",
        // Scoped to the CLIENT's own applications. Unscoped, any audit row
        // naming this document authenticated it for any application of any
        // client in the tenant.
        entityId: { in: ["app-1"] },
        AND: [
          { newValue: { path: ["documentId"], equals: "agreement-doc-1" } },
          { newValue: { path: ["documentSha256"], equals: AGREEMENT_SHA256 } },
        ],
      },
      select: { id: true },
    })
  })

  it("continues serving ordinary client documents without an agreement binding", async () => {
    const bankBytes = Buffer.from("%PDF-1.4 bank statement")
    clientDocumentFindFirst.mockResolvedValue({
      id: "bank-doc-1",
      clientId: "client-1",
      docType: "BANK_STATEMENT",
      fileName: "statement.pdf",
      mimeType: "application/pdf",
      storagePath: "/documents/statement.pdf",
      contentSha256: null,
      deletedAt: null,
    })
    readFile.mockResolvedValue(bankBytes)

    const response = await GET(request(), context)

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bankBytes)
    expect(loanApplicationFindFirst).not.toHaveBeenCalled()
    expect(auditLogFindFirst).not.toHaveBeenCalled()
  })
})

describe("GET /api/documents/[id]/view generation-binding scoping", () => {
  it("refuses a binding that belongs to ANOTHER client's application", async () => {
    // The reader-side half of the double-binding defect. The audit row names
    // this document and its digest, so the OLD unscoped lookup authenticated
    // it — even though the row belongs to an application this client does not
    // own. Paired with a backfill that could write a second binding, that let
    // one loan carry two documents both serving as the authentic agreement.
    // Use the suite's default agreement fixture — it is the one the integrity
    // branch applies to.
    loanApplicationFindFirst.mockResolvedValue(null)
    loanApplicationFindMany.mockResolvedValue([{ id: "app-1" }])
    // A binding EXISTS for these exact bytes — but on someone else's
    // application, so the scoped query must not return it.
    auditLogFindFirst.mockResolvedValue(null)

    const response = await GET(request(), context)

    expect(response.status).toBe(422)
    expect(auditLogFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityId: { in: ["app-1"] } }),
      }),
    )
  })

  it("does not query audit history when the client owns no applications", async () => {
    // Anti-vacuity in the other direction: an empty scope must refuse without
    // falling back to an unscoped lookup.
    loanApplicationFindFirst.mockResolvedValue(null)
    loanApplicationFindMany.mockResolvedValue([])
    auditLogFindFirst.mockClear()

    const response = await GET(request(), context)

    expect(response.status).toBe(422)
    expect(auditLogFindFirst).not.toHaveBeenCalled()
  })
})
