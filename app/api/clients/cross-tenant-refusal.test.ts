import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getDocumentCallerMock = vi.fn()
const logAuditMock = vi.fn()
const authMock = vi.fn()

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
  prisma: new Proxy({}, { get: () => { throw new Error("handler must not run") } }),
}))
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))

import { GET as listDocuments } from "./[id]/documents/route"
import { GET as listSigningPackets } from "./[id]/signing-packets/route"

const ctx = { params: Promise.resolve({ id: "cl_b" }) }
const req = () => new NextRequest("https://a.acme-lending.example/api/clients/cl_b/documents")

describe("client document listings — a tenant-B client on tenant A's host", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocumentCallerMock.mockResolvedValue({ type: "client", clientId: "cl_b", email: "b-client@example.test" })
    authMock.mockResolvedValue({ user: { id: "cl_b", email: "b-client@example.test", tenantId: "tenant-beta-id" } })
  })

  it.each([
    ["documents", listDocuments, "client:cl_b"],
    ["signing-packets", listSigningPackets, "client:cl_b:signing-packets"],
  ] as const)("%s: 403 and split refusal rows", async (_n, handler, entityId) => {
    const res = await handler(req(), ctx)
    expect(res.status).toBe(403)
    expect(logAuditMock).toHaveBeenCalledTimes(2)
    const [rowA, rowB] = logAuditMock.mock.calls.map(([x]) => x as Record<string, unknown>)
    expect(rowA).toMatchObject({
      entityId,
      tenantId: "tenant-alpha-id",
      newValue: expect.objectContaining({ reason: "tenant_scope_refused", httpStatus: 403 }),
    })
    expect(rowA.userId).toBeUndefined()
    expect(rowA.userEmail).toBeUndefined()
    expect(JSON.stringify(rowA)).not.toContain("b-client@example.test")
    expect(rowB).toMatchObject({
      tenantId: "tenant-beta-id",
      userEmail: "b-client@example.test",
      newValue: expect.objectContaining({ reason: "cross_tenant_access_attempt" }),
    })
    expect(JSON.stringify(rowB)).not.toContain("tenant-alpha-id")
    expect(JSON.stringify(rowB)).not.toContain(entityId)
  })
})
