import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getDocumentCallerMock = vi.fn()
const logAuditMock = vi.fn()
const handlerSpy = vi.fn()
const authMock = vi.fn()

// The wrapper refuses a principal bound to another tenant before any handler
// runs, exactly as lib/tenant.ts withTenantContext does for a mismatched session.
vi.mock("@/lib/tenant", async () => {
  const { NextResponse } = await import("next/server")
  return {
    withTenantContext: async () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    getTenantFromRequest: async () => ({ id: "tenant-alpha-id" }),
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
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))

import { GET as getDocument, DELETE as deleteDocument } from "./[id]/route"
import { POST as uploadDocument } from "./route"
import { POST as signDocument } from "./[id]/sign/route"
import { POST as uploadSelfie } from "./selfie/route"

const tenantBClient = { type: "client", clientId: "cl_b", email: "b-client@example.test" }

const tenantBClientSession = { user: { id: "cl_b", email: "b-client@example.test", tenantId: "tenant-beta-id" } }
const tenantBStaffSession = { user: { id: "u_b", email: "b-staff@example.test", tenantId: "tenant-beta-id" } }
const tenantBStaff = { type: "staff", userId: "u_b", role: "LOAN_ADMIN", tenantId: "tenant-beta-id" }

// Tenant A's register learns of the probe but not WHO probed (a different
// responsible party); tenant B's register learns who, but nothing of tenant A.
function expectSplitRefusal(entityId: string, actor: { email: string; userId?: string; id: string }) {
  expect(handlerSpy).not.toHaveBeenCalled()
  expect(logAuditMock).toHaveBeenCalledTimes(2)
  const [rowA, rowB] = logAuditMock.mock.calls.map(([a]) => a as Record<string, unknown>)

  expect(rowA).toMatchObject({
    action: "DOCUMENT_ACCESS_REFUSED",
    entity: "ClientDocument",
    entityId,
    tenantId: "tenant-alpha-id",
    newValue: expect.objectContaining({ refused: true, reason: "tenant_scope_refused", httpStatus: 403 }),
  })
  expect(rowA.userId).toBeUndefined()
  expect(rowA.userEmail).toBeUndefined()
  expect(JSON.stringify(rowA)).not.toContain(actor.email)
  expect(JSON.stringify(rowA)).not.toContain("tenant-beta-id")

  expect(rowB).toMatchObject({
    tenantId: "tenant-beta-id",
    userEmail: actor.email,
    newValue: expect.objectContaining({ refused: true, reason: "cross_tenant_access_attempt", httpStatus: 403 }),
  })
  expect(rowB.userId).toBe(actor.userId)
  expect(rowB.entityId).toBe(actor.id)
  const serialisedB = JSON.stringify(rowB)
  expect(serialisedB).not.toContain("tenant-alpha-id")
  expect(serialisedB).not.toContain(entityId)
}

const clientActor = { email: "b-client@example.test", id: "cl_b" }

const ctx = { params: Promise.resolve({ id: "doc_1" }) }
const req = () => new NextRequest("https://a.acme-lending.example/api/documents/doc_1", { method: "POST" })

describe("document routes — a tenant-B principal on tenant A's host", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocumentCallerMock.mockResolvedValue(tenantBClient)
    authMock.mockResolvedValue(tenantBClientSession)
  })

  it("GET /api/documents/[id]: 403 and a tenant-A row without the actor and a tenant-B row with them", async () => {
    const res = await getDocument(req(), ctx)
    expect(res.status).toBe(403)
    expectSplitRefusal("doc_1", clientActor)
  })

  it("DELETE /api/documents/[id]: 403 with the split refusal rows", async () => {
    const res = await deleteDocument(req(), ctx)
    expect(res.status).toBe(403)
    expectSplitRefusal("doc_1", clientActor)
  })

  it("POST /api/documents/[id]/sign: 403 with the split refusal rows", async () => {
    const res = await signDocument(req(), ctx)
    expect(res.status).toBe(403)
    expectSplitRefusal("doc_1", clientActor)
  })

  it("POST /api/documents (upload): 403 with the split refusal rows", async () => {
    const res = await uploadDocument(req())
    expect(res.status).toBe(403)
    expectSplitRefusal("upload", clientActor)
  })

  it("POST /api/documents/selfie: 403 with the split refusal rows", async () => {
    const res = await uploadSelfie(req())
    expect(res.status).toBe(403)
    expectSplitRefusal("selfie", clientActor)
  })

  it("cross-tenant staff: tenant A row carries no id or email, tenant B row carries both", async () => {
    getDocumentCallerMock.mockResolvedValue(tenantBStaff)
    authMock.mockResolvedValue(tenantBStaffSession)

    const res = await getDocument(req(), ctx)

    expect(res.status).toBe(403)
    expectSplitRefusal("doc_1", { email: "b-staff@example.test", userId: "u_b", id: "u_b" })
  })
})
