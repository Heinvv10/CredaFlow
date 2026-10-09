import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRole,
  findFirstClientDocument,
  findFirstDocumentTemplate,
  findFirstClient,
  getSigner,
  requestSignature,
  logAudit,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  findFirstClientDocument: vi.fn(),
  findFirstDocumentTemplate: vi.fn(),
  findFirstClient: vi.fn(),
  getSigner: vi.fn(),
  requestSignature: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: { findFirst: findFirstClientDocument },
    documentTemplate: { findFirst: findFirstDocumentTemplate },
    client: { findFirst: findFirstClient },
  },
}))
vi.mock("@/lib/documents/signing", () => ({ getSigner }))
vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: { DOCUMENT_SIGNATURE_REQUESTED: "DOCUMENT_SIGNATURE_REQUESTED" },
}))

import { POST } from "./route"

function req() {
  return new NextRequest("http://x/api/documents/doc1/request-signature", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
}

function ctx() {
  return { params: Promise.resolve({ id: "doc1" }) }
}

const DOC = {
  id: "doc1",
  tenantId: "t1",
  clientId: "client-1",
  templateId: "tmpl-1",
  deletedAt: null,
}

const CLIENT = { id: "client-1", firstName: "Thabo", lastName: "M", email: "thabo@example.test" }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRole.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "READONLY" } })
  findFirstClientDocument.mockResolvedValue(DOC)
  findFirstClient.mockResolvedValue(CLIENT)
  getSigner.mockReturnValue({ requestSignature })
  logAudit.mockResolvedValue(undefined)
})

describe("POST /api/documents/[id]/request-signature", () => {
  it("returns 401/403 when the caller is unauthorized", async () => {
    const { NextResponse } = await import("next/server")
    requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })

    const res = await POST(req(), ctx())

    expect(res.status).toBe(401)
    expect(findFirstClientDocument).not.toHaveBeenCalled()
  })

  it("404s when the document doesn't exist", async () => {
    findFirstClientDocument.mockResolvedValue(null)

    const res = await POST(req(), ctx())

    expect(res.status).toBe(404)
    expect(getSigner).not.toHaveBeenCalled()
  })

  it("404s when the document is soft-deleted", async () => {
    findFirstClientDocument.mockResolvedValue({ ...DOC, deletedAt: new Date() })

    const res = await POST(req(), ctx())

    expect(res.status).toBe(404)
  })

  it("rejects the generic provider-signing path for a credit agreement", async () => {
    findFirstClientDocument.mockResolvedValue({
      ...DOC,
      docType: "CREDIT_AGREEMENT",
    })

    const res = await POST(req(), ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      agreementIntegrity: "dedicated_signing_required",
    }))
    expect(findFirstDocumentTemplate).not.toHaveBeenCalled()
    expect(getSigner).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("NATIVE: 200, calls getSigner(NATIVE).requestSignature with tenantId + docId + signers, and audits", async () => {
    findFirstDocumentTemplate.mockResolvedValue({ id: "tmpl-1", signingMethod: "NATIVE" })
    requestSignature.mockResolvedValue({ ref: "doc1", status: "pending" })

    const res = await POST(req(), ctx())

    expect(res.status).toBe(200)
    expect(getSigner).toHaveBeenCalledWith("NATIVE")
    expect(requestSignature).toHaveBeenCalledWith("t1", "doc1", [
      { name: "Thabo M", email: "thabo@example.test" },
    ])

    const body = await res.json()
    expect(body).toEqual({ ref: "doc1", status: "pending" })

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: "u1",
        action: "DOCUMENT_SIGNATURE_REQUESTED",
        entity: "ClientDocument",
        entityId: "doc1",
      })
    )
  })

  it("400s when the template's signingMethod is NONE, without calling the signer", async () => {
    findFirstDocumentTemplate.mockResolvedValue({ id: "tmpl-1", signingMethod: "NONE" })

    const res = await POST(req(), ctx())

    expect(res.status).toBe(400)
    expect(getSigner).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("400s when the document has no templateId (nothing to sign)", async () => {
    findFirstClientDocument.mockResolvedValue({ ...DOC, templateId: null })

    const res = await POST(req(), ctx())

    expect(res.status).toBe(400)
    expect(findFirstDocumentTemplate).not.toHaveBeenCalled()
    expect(getSigner).not.toHaveBeenCalled()
  })

  it("maps a SIGNUM (flag-off) rejection to a stable error instead of 500", async () => {
    findFirstDocumentTemplate.mockResolvedValue({ id: "tmpl-1", signingMethod: "SIGNUM" })
    requestSignature.mockRejectedValue(
      new Error("Signum signing is not enabled (DOCUMENT_SIGNUM_ENABLED)")
    )

    const res = await POST(req(), ctx())

    expect([409, 501]).toContain(res.status)
    const body = await res.json()
    expect(body.error).toMatch(/signum/i)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("404s when the client no longer resolves for the tenant", async () => {
    findFirstDocumentTemplate.mockResolvedValue({ id: "tmpl-1", signingMethod: "NATIVE" })
    findFirstClient.mockResolvedValue(null)

    const res = await POST(req(), ctx())

    expect(res.status).toBe(404)
    expect(getSigner).not.toHaveBeenCalled()
  })
})
