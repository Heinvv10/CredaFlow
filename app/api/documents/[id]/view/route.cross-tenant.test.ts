import { beforeEach, describe, expect, it, vi } from "vitest"

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
vi.mock("@/lib/document-auth", () => ({ getDocumentCaller: () => getDocumentCallerMock() }))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/storage", () => ({ readFile: vi.fn() }))

import { GET } from "./route"

const ctx = { params: Promise.resolve({ id: "doc_probed" }) }
const req = () => new Request("https://a.acme-lending.example/api/documents/doc_probed/view")

describe("GET /api/documents/[id]/view — cross-tenant principal", () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    [
      "portal client",
      { type: "client", clientId: "cl_b", email: "b-client@example.test" },
      { user: { id: "cl_b", email: "b-client@example.test", tenantId: "tenant-beta-id" } },
      { userId: undefined, id: "cl_b", email: "b-client@example.test" },
    ],
    [
      "staff",
      { type: "staff", userId: "u_b", role: "LOAN_ADMIN", tenantId: "tenant-beta-id" },
      { user: { id: "u_b", email: "b-staff@example.test", tenantId: "tenant-beta-id" } },
      { userId: "u_b", id: "u_b", email: "b-staff@example.test" },
    ],
  ])("%s: A's row has no actor, B's row has the actor and no A identifiers", async (_n, caller, session, actor) => {
    getDocumentCallerMock.mockResolvedValue(caller)
    authMock.mockResolvedValue(session)

    const res = await GET(req(), ctx)

    expect(res.status).toBe(403)
    expect(logAuditMock).toHaveBeenCalledTimes(2)
    const [rowA, rowB] = logAuditMock.mock.calls.map(([x]) => x as Record<string, unknown>)
    expect(rowA).toMatchObject({ tenantId: "tenant-alpha-id", entityId: "doc_probed" })
    expect(rowA.userId).toBeUndefined()
    expect(rowA.userEmail).toBeUndefined()
    expect(JSON.stringify(rowA)).not.toContain(actor.email)
    expect(rowB).toMatchObject({ tenantId: "tenant-beta-id", userEmail: actor.email, entityId: actor.id })
    expect(rowB.userId).toBe(actor.userId)
    expect(JSON.stringify(rowB)).not.toContain("tenant-alpha-id")
    expect(JSON.stringify(rowB)).not.toContain("doc_probed")
  })
})
