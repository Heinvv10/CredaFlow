import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getDocumentCallerMock = vi.fn()
const logAuditMock = vi.fn()

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
  prisma: new Proxy({}, { get: () => { throw new Error("handler must not run") } }),
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))

import { GET as listDocuments } from "./[id]/documents/route"
import { GET as listSigningPackets } from "./[id]/signing-packets/route"

const ctx = { params: Promise.resolve({ id: "cl_b" }) }
const req = () => new NextRequest("https://a.acme-lending.example/api/clients/cl_b/documents")

describe("client document listings — a tenant-B client on tenant A's host", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocumentCallerMock.mockResolvedValue({ type: "client", clientId: "cl_b", email: "b-client@example.test" })
  })

  it.each([
    ["documents", listDocuments, "client:cl_b"],
    ["signing-packets", listSigningPackets, "client:cl_b:signing-packets"],
  ] as const)("%s: 403 and exactly one refusal row in tenant A", async (_n, handler, entityId) => {
    const res = await handler(req(), ctx)
    expect(res.status).toBe(403)
    expect(logAuditMock).toHaveBeenCalledTimes(1)
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId,
        tenantId: "tenant_a",
        userEmail: "b-client@example.test",
        newValue: expect.objectContaining({ reason: "tenant_scope_refused", httpStatus: 403 }),
      }),
    )
  })
})
