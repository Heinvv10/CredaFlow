import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getDocumentCallerMock = vi.fn()
const logAuditMock = vi.fn()
const handlerSpy = vi.fn()

// The wrapper refuses a principal bound to another tenant before any handler
// runs, exactly as lib/tenant.ts withTenantContext does for a mismatched session.
vi.mock("@/lib/tenant", async () => {
  const { NextResponse } = await import("next/server")
  return {
    withTenantContext: async () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    getTenantFromRequest: async () => ({ id: "tenant_a" }),
  }
})
vi.mock("@/lib/document-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/document-auth")>()),
  getDocumentCaller: () => getDocumentCallerMock(),
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => { handlerSpy(); throw new Error("handler must not run") } }),
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))

import { GET as getDocument, DELETE as deleteDocument } from "./[id]/route"
import { POST as uploadDocument } from "./route"
import { POST as signDocument } from "./[id]/sign/route"
import { POST as uploadSelfie } from "./selfie/route"

const tenantBClient = { type: "client", clientId: "cl_b", email: "b-client@example.test" }

function expectOneCrossTenantRefusal(entityId: string) {
  expect(handlerSpy).not.toHaveBeenCalled()
  expect(logAuditMock).toHaveBeenCalledTimes(1)
  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "DOCUMENT_ACCESS_REFUSED",
      entity: "ClientDocument",
      entityId,
      tenantId: "tenant_a",
      userEmail: "b-client@example.test",
      newValue: expect.objectContaining({ refused: true, reason: "tenant_scope_refused", httpStatus: 403 }),
    }),
  )
}

const ctx = { params: Promise.resolve({ id: "doc_1" }) }
const req = () => new NextRequest("https://a.acme-lending.example/api/documents/doc_1", { method: "POST" })

describe("document routes — a tenant-B principal on tenant A's host", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocumentCallerMock.mockResolvedValue(tenantBClient)
  })

  it("GET /api/documents/[id]: 403 and exactly one refusal row", async () => {
    const res = await getDocument(req(), ctx)
    expect(res.status).toBe(403)
    expectOneCrossTenantRefusal("doc_1")
  })

  it("DELETE /api/documents/[id]: 403 and one refusal row", async () => {
    const res = await deleteDocument(req(), ctx)
    expect(res.status).toBe(403)
    expectOneCrossTenantRefusal("doc_1")
  })

  it("POST /api/documents/[id]/sign: 403 and one refusal row", async () => {
    const res = await signDocument(req(), ctx)
    expect(res.status).toBe(403)
    expectOneCrossTenantRefusal("doc_1")
  })

  it("POST /api/documents (upload): 403 and one refusal row", async () => {
    const res = await uploadDocument(req())
    expect(res.status).toBe(403)
    expectOneCrossTenantRefusal("upload")
  })

  it("POST /api/documents/selfie: 403 and one refusal row", async () => {
    const res = await uploadSelfie(req())
    expect(res.status).toBe(403)
    expectOneCrossTenantRefusal("selfie")
  })

  it("logs the staff actor id for a cross-tenant staff user", async () => {
    getDocumentCallerMock.mockResolvedValue({ type: "staff", userId: "u_b", role: "LOAN_ADMIN", tenantId: "tenant_b" })
    await getDocument(req(), ctx)
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "u_b", tenantId: "tenant_a" }))
  })
})
