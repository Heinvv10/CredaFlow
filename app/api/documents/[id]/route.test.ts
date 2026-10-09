import { describe, it, expect, vi, beforeEach } from "vitest"

const clientDocumentFindFirstMock = vi.fn()
const documentAccessLogCreateMock = vi.fn()
const getDocumentCallerMock = vi.fn()
const withTenantContextMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: { findFirst: (a: unknown) => clientDocumentFindFirstMock(a) },
    documentAccessLog: { create: (a: unknown) => documentAccessLogCreateMock(a) },
  },
}))
vi.mock("@/lib/storage", () => ({ deleteFile: vi.fn(), readFile: vi.fn() }))
vi.mock("@/lib/document-auth", () => ({ getDocumentCaller: () => getDocumentCallerMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))

import { GET, DELETE } from "./route"

function buildReq(): Request {
  return new Request("https://staging.acme-lending.example/api/documents/doc_1", {
    headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "vitest" },
  })
}

const ctx = { params: Promise.resolve({ id: "doc_1" }) }

beforeEach(() => {
  vi.resetAllMocks()
  withTenantContextMock.mockImplementation(async (_req, cb) => cb({ id: "tenant_acme" }))
  getDocumentCallerMock.mockResolvedValue({
    type: "staff",
    userId: "u_1",
    role: "LOAN_ADMIN",
    tenantId: "tenant_acme",
  })
  clientDocumentFindFirstMock.mockResolvedValue({
    id: "doc_1",
    clientId: "cl_1",
    tenantId: "tenant_acme",
    deletedAt: null,
    storagePath: "docs/doc_1.pdf",
    extractionResult: { idNumber: "9001016000087" },
  })
  documentAccessLogCreateMock.mockResolvedValue({ id: "log_1" })
})

describe("GET /api/documents/[id] — POPIA access log", () => {
  it("staff GET: 200 + writes a DocumentAccessLog (action=metadata, staff id)", async () => {
    const res = await GET(buildReq(), ctx)
    expect(res.status).toBe(200)
    expect(documentAccessLogCreateMock).toHaveBeenCalledTimes(1)
    expect(documentAccessLogCreateMock.mock.calls[0][0].data).toMatchObject({
      documentId: "doc_1",
      accessorType: "staff",
      accessorId: "u_1",
      action: "metadata",
      ipAddress: "203.0.113.9",
    })
  })

  it("client owner GET: 200 + logs the CLIENT id as accessor", async () => {
    getDocumentCallerMock.mockResolvedValue({ type: "client", clientId: "cl_1", email: "a@b.c" })
    const res = await GET(buildReq(), ctx)
    expect(res.status).toBe(200)
    expect(documentAccessLogCreateMock.mock.calls[0][0].data).toMatchObject({
      accessorType: "client",
      accessorId: "cl_1",
    })
  })

  it("returns retained credit-agreement metadata without exposing its storage path", async () => {
    clientDocumentFindFirstMock.mockResolvedValue({
      id: "doc_1",
      clientId: "cl_1",
      tenantId: "tenant_acme",
      docType: "CREDIT_AGREEMENT",
      deletedAt: null,
      storagePath: "docs/private-agreement.pdf",
      contentSha256: "a".repeat(64),
    })

    const res = await GET(buildReq(), ctx)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(expect.objectContaining({
      id: "doc_1",
      docType: "CREDIT_AGREEMENT",
      contentSha256: "a".repeat(64),
    }))
    expect(body).not.toHaveProperty("storagePath")
    expect(documentAccessLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentId: "doc_1", action: "metadata" }),
    })
  })

  it("unauthenticated: 401 + NO log", async () => {
    getDocumentCallerMock.mockResolvedValue(null)
    const res = await GET(buildReq(), ctx)
    expect(res.status).toBe(401)
    expect(documentAccessLogCreateMock).not.toHaveBeenCalled()
  })

  it("document not found: 404 + NO log", async () => {
    clientDocumentFindFirstMock.mockResolvedValue(null)
    const res = await GET(buildReq(), ctx)
    expect(res.status).toBe(404)
    expect(documentAccessLogCreateMock).not.toHaveBeenCalled()
  })

  it("client accessing another client's doc: 403 + NO log", async () => {
    getDocumentCallerMock.mockResolvedValue({ type: "client", clientId: "cl_OTHER", email: "a@b.c" })
    const res = await GET(buildReq(), ctx)
    expect(res.status).toBe(403)
    expect(documentAccessLogCreateMock).not.toHaveBeenCalled()
  })
})

// Deleting a client document destroys evidence. The credit agreement in
// particular cannot be regenerated once signed (POST /agreement returns 409),
// and there is no un-delete endpoint — so a mistaken delete is recoverable
// only by re-papering the loan and making the consumer sign again. Restricted
// to SUPER_ADMIN; every other staff role is refused before any state changes.
describe("DELETE /api/documents/[id] — SUPER_ADMIN only", () => {
  const roles = ["LOAN_ADMIN", "CREDIT_OFFICER", "BRANCH_MANAGER", "COLLECTIONS_AGENT", "ADMIN"]

  for (const role of roles) {
    it(`refuses ${role}: 403, nothing read or written`, async () => {
      getDocumentCallerMock.mockResolvedValue({
        type: "staff", userId: "u_1", role, tenantId: "tenant_acme",
      })
      const res = await DELETE(buildReq(), ctx)
      expect(res.status).toBe(403)
      expect((await res.json()).error).toMatch(/super admin/i)
      // Refused before the document is even looked up — no side effects.
      expect(clientDocumentFindFirstMock).not.toHaveBeenCalled()
    })
  }

  it("lets SUPER_ADMIN through to the deletion path", async () => {
    getDocumentCallerMock.mockResolvedValue({
      type: "staff", userId: "u_1", role: "SUPER_ADMIN", tenantId: "tenant_acme",
    })
    const res = await DELETE(buildReq(), ctx)
    // Not 403 — the role gate is passed. Whatever it returns after that is the
    // pre-existing deletion path, exercised elsewhere.
    expect(res.status).not.toBe(403)
    expect(clientDocumentFindFirstMock).toHaveBeenCalled()
  })

  it("still refuses an unauthenticated caller with 401, not 403", async () => {
    getDocumentCallerMock.mockResolvedValue(null)
    const res = await DELETE(buildReq(), ctx)
    expect(res.status).toBe(401)
  })

  // A client is not staff and must not be caught by the staff role gate — the
  // portal's own "verified documents cannot be deleted" rule still governs it.
  it("does not apply the SUPER_ADMIN gate to a portal client", async () => {
    getDocumentCallerMock.mockResolvedValue({ type: "client", clientId: "cl_1", email: "a@b.c" })
    const res = await DELETE(buildReq(), ctx)
    expect(res.status).not.toBe(403)
  })
})
