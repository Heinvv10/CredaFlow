import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const logAuditMock = vi.fn()
const authMock = vi.fn()
const withTenantContextMock = vi.fn()
const getTenantFromRequestMock = vi.fn()

vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) => withTenantContextMock(req, cb),
  getTenantFromRequest: () => getTenantFromRequestMock(),
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))

import { withTenantContextLoggingRefusal } from "./tenant-refusal"

const caller = { type: "client", clientId: "cl_1", email: "client@example.test" } as const
const req = new Request("https://a.acme-lending.example/api/documents/doc_1")

describe("withTenantContextLoggingRefusal", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-alpha-id" })
    authMock.mockResolvedValue({ user: { id: "cl_1", email: "client@example.test", tenantId: "tenant-alpha-id" } })
  })

  it("writes NO row when the handler ran and returned its own 4xx (no double-log)", async () => {
    withTenantContextMock.mockImplementation(async (_r, cb) => cb({ id: "tenant-alpha-id" }))

    const res = await withTenantContextLoggingRefusal(req, { documentId: "doc_1", caller }, async () =>
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    )

    expect((res as Response).status).toBe(403)
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("writes NO row for the wrapper's 400 when no tenant resolves (unretrievable row)", async () => {
    withTenantContextMock.mockResolvedValue(NextResponse.json({ error: "Tenant not found" }, { status: 400 }))
    getTenantFromRequestMock.mockResolvedValue(null)

    const res = await withTenantContextLoggingRefusal(req, { documentId: "doc_1", caller }, async () => NextResponse.json({}))

    expect((res as Response).status).toBe(400)
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("logs a same-tenant wrapper refusal once, attributed in the request tenant", async () => {
    withTenantContextMock.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }))

    await withTenantContextLoggingRefusal(req, { documentId: "doc_1", caller }, async () => NextResponse.json({}))

    expect(logAuditMock).toHaveBeenCalledTimes(1)
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-alpha-id", userEmail: "client@example.test", entityId: "doc_1" }),
    )
  })
})
