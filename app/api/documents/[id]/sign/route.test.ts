import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  getDocumentCaller,
  findFirstClientDocument,
  updateClientDocument,
  createDocumentAccessLog,
  logAudit,
} = vi.hoisted(() => ({
  getDocumentCaller: vi.fn(),
  findFirstClientDocument: vi.fn(),
  updateClientDocument: vi.fn(),
  createDocumentAccessLog: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("@/lib/document-auth", () => ({ getDocumentCaller }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: { findFirst: findFirstClientDocument, update: updateClientDocument },
    documentAccessLog: { create: createDocumentAccessLog },
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: { DOCUMENT_SIGNED: "DOCUMENT_SIGNED" },
}))

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://x/api/documents/doc1/sign", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

function ctx() {
  return { params: Promise.resolve({ id: "doc1" }) }
}

const PENDING_DOC = {
  id: "doc1",
  tenantId: "t1",
  clientId: "client-1",
  deletedAt: null,
  signatureState: "pending",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("TRUSTED_PROXY", "1")
  findFirstClientDocument.mockResolvedValue(PENDING_DOC)
  updateClientDocument.mockResolvedValue({ ...PENDING_DOC, signatureState: "signed" })
  createDocumentAccessLog.mockResolvedValue({})
  logAudit.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("POST /api/documents/[id]/sign", () => {
  it("returns 401 when unauthenticated", async () => {
    getDocumentCaller.mockResolvedValue(null)

    const res = await POST(req({ method: "branch" }), ctx())

    expect(res.status).toBe(401)
    expect(findFirstClientDocument).not.toHaveBeenCalled()
  })

  it("400s when method is missing/invalid", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })

    const res = await POST(req({}), ctx())

    expect(res.status).toBe(400)
    expect(findFirstClientDocument).not.toHaveBeenCalled()
    expect(updateClientDocument).not.toHaveBeenCalled()
  })

  it("staff signs successfully: 200, stamps signed + IP + audit + access log", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })

    const res = await POST(
      req({ method: "branch" }, { "x-forwarded-for": "41.1.2.3, 10.0.0.1" }),
      ctx()
    )

    expect(res.status).toBe(200)

    expect(updateClientDocument).toHaveBeenCalledWith({
      where: { id: "doc1", tenantId: "t1" },
      data: expect.objectContaining({
        signatureState: "signed",
        signedAt: expect.any(Date),
        signedByIp: "10.0.0.1",
      }),
    })

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: "u1",
        action: "DOCUMENT_SIGNED",
        entity: "ClientDocument",
        entityId: "doc1",
        ipAddress: "10.0.0.1",
      })
    )

    expect(createDocumentAccessLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: "doc1",
        accessorType: "staff",
        accessorId: "u1",
        action: "signed",
        ipAddress: "10.0.0.1",
      }),
    })
  })

  it("409s when the document is already signed, without mutating", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })
    findFirstClientDocument.mockResolvedValue({ ...PENDING_DOC, signatureState: "signed" })

    const res = await POST(req({ method: "branch" }), ctx())

    expect(res.status).toBe(409)
    expect(updateClientDocument).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
    expect(createDocumentAccessLog).not.toHaveBeenCalled()
  })

  it("rejects the generic signing path for a credit agreement", async () => {
    getDocumentCaller.mockResolvedValue({ type: "client", clientId: "client-1", email: "x@y.com" })
    findFirstClientDocument.mockResolvedValue({
      ...PENDING_DOC,
      docType: "CREDIT_AGREEMENT",
    })

    const res = await POST(req({ method: "portal" }), ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      agreementIntegrity: "dedicated_signing_required",
    }))
    expect(updateClientDocument).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
    expect(createDocumentAccessLog).not.toHaveBeenCalled()
  })

  it("404s when the document doesn't exist", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })
    findFirstClientDocument.mockResolvedValue(null)

    const res = await POST(req({ method: "branch" }), ctx())

    expect(res.status).toBe(404)
    expect(updateClientDocument).not.toHaveBeenCalled()
  })

  it("403s when a CLIENT session tries to sign another client's document, without mutating", async () => {
    getDocumentCaller.mockResolvedValue({ type: "client", clientId: "someone-else", email: "x@y.com" })

    const res = await POST(req({ method: "portal" }), ctx())

    expect(res.status).toBe(403)
    expect(updateClientDocument).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
    expect(createDocumentAccessLog).not.toHaveBeenCalled()
  })

  it("allows a CLIENT session to sign their OWN document", async () => {
    getDocumentCaller.mockResolvedValue({ type: "client", clientId: "client-1", email: "x@y.com" })

    const res = await POST(req({ method: "portal" }), ctx())

    expect(res.status).toBe(200)
    expect(updateClientDocument).toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined, userEmail: "x@y.com" })
    )
    expect(createDocumentAccessLog).toHaveBeenCalledWith({
      data: expect.objectContaining({ accessorType: "client", accessorId: "client-1" }),
    })
  })
})
