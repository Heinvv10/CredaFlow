/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findFirstMock = vi.fn()
const updateMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: unknown) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    documentTemplate: {
      findFirst: (args: unknown) => findFirstMock(args),
      update: (args: unknown) => updateMock(args),
    },
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (args: unknown) => logAuditMock(args),
  AuditAction: {
    DOCUMENT_TEMPLATE_CREATED: "DOCUMENT_TEMPLATE_CREATED",
    DOCUMENT_TEMPLATE_UPDATED: "DOCUMENT_TEMPLATE_UPDATED",
    DOCUMENT_TEMPLATE_DELETED: "DOCUMENT_TEMPLATE_DELETED",
  },
}))

import { GET, PATCH, DELETE } from "./route"

function ctx(id = "tpl1") {
  return { params: Promise.resolve({ id }) }
}

function req(method: string, body?: object) {
  return new NextRequest(`http://x/api/documents/templates/tpl1`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

const CUSTOM_TEMPLATE = {
  id: "tpl1",
  tenantId: "t1",
  key: "settlement_letter",
  name: "Settlement Letter",
  category: "Collections",
  kind: "CUSTOM",
  signingMethod: "NONE",
  requiresApproval: false,
  deletedAt: null,
}

const SYSTEM_TEMPLATE = {
  ...CUSTOM_TEMPLATE,
  id: "tpl_sys",
  kind: "SYSTEM",
  key: "credit_agreement",
  name: "Small Credit Loans Agreement",
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "LOAN_ADMIN" } })
  logAuditMock.mockResolvedValue(undefined)
})

// ---- GET ----

it("GET returns 401 when unauthenticated", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await GET(req("GET"), ctx())
  expect(res.status).toBe(401)
  expect(findFirstMock).not.toHaveBeenCalled()
})

it("GET returns 404 when the template doesn't exist in this tenant", async () => {
  findFirstMock.mockResolvedValue(null)
  const res = await GET(req("GET"), ctx())
  expect(res.status).toBe(404)
})

it("GET returns the template when found", async () => {
  findFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  const res = await GET(req("GET"), ctx())
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual(CUSTOM_TEMPLATE)
  expect(findFirstMock).toHaveBeenCalledWith({
    where: { id: "tpl1", tenantId: "t1", deletedAt: null },
  })
})

// ---- PATCH ----

it("PATCH returns 401 when unauthenticated and does not touch the DB", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await PATCH(req("PATCH", { name: "New Name" }), ctx())
  expect(res.status).toBe(401)
  expect(findFirstMock).not.toHaveBeenCalled()
})

it("PATCH returns 404 for a missing/cross-tenant id and does not update or audit", async () => {
  findFirstMock.mockResolvedValue(null)
  const res = await PATCH(req("PATCH", { name: "New Name" }), ctx())
  expect(res.status).toBe(404)
  expect(updateMock).not.toHaveBeenCalled()
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("PATCH on a SYSTEM template returns 403 and performs no update/audit", async () => {
  findFirstMock.mockResolvedValue(SYSTEM_TEMPLATE)
  const res = await PATCH(req("PATCH", { name: "Hacked Name" }), ctx("tpl_sys"))
  expect(res.status).toBe(403)
  const body = await res.json()
  expect(body.error).toMatch(/read-only/i)
  expect(updateMock).not.toHaveBeenCalled()
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("PATCH on a CUSTOM template updates fields and audits with old/new values", async () => {
  findFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  updateMock.mockResolvedValue({ ...CUSTOM_TEMPLATE, name: "Updated Name", requiresApproval: true })

  const res = await PATCH(req("PATCH", { name: "Updated Name", requiresApproval: true }), ctx())
  expect(res.status).toBe(200)

  expect(updateMock).toHaveBeenCalledWith({
    where: { id: "tpl1" },
    data: { name: "Updated Name", requiresApproval: true },
  })

  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      action: "DOCUMENT_TEMPLATE_UPDATED",
      entity: "DocumentTemplate",
      entityId: "tpl1",
      oldValue: expect.objectContaining({ name: "Settlement Letter" }),
      newValue: expect.objectContaining({ name: "Updated Name" }),
    })
  )

  const body = await res.json()
  expect(body.name).toBe("Updated Name")
})

it("PATCH audits the persisted shape, not the raw request body (trims name, drops junk fields)", async () => {
  findFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  updateMock.mockResolvedValue({ ...CUSTOM_TEMPLATE, name: "Trimmed Name" })

  const res = await PATCH(
    req("PATCH", { name: "  Trimmed Name  ", junkField: "should not be audited" }),
    ctx()
  )
  expect(res.status).toBe(200)

  const auditCall = logAuditMock.mock.calls[0][0]
  expect(auditCall.newValue).not.toHaveProperty("junkField")
  expect(auditCall.newValue).toEqual({
    name: "Trimmed Name",
    category: CUSTOM_TEMPLATE.category,
    signingMethod: CUSTOM_TEMPLATE.signingMethod,
    requiresApproval: CUSTOM_TEMPLATE.requiresApproval,
  })
})

// ---- DELETE ----

it("DELETE returns 401 when unauthenticated and does not touch the DB", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await DELETE(req("DELETE"), ctx())
  expect(res.status).toBe(401)
  expect(findFirstMock).not.toHaveBeenCalled()
})

it("DELETE returns 404 for a missing/cross-tenant id", async () => {
  findFirstMock.mockResolvedValue(null)
  const res = await DELETE(req("DELETE"), ctx())
  expect(res.status).toBe(404)
  expect(updateMock).not.toHaveBeenCalled()
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("DELETE on a SYSTEM template returns 403 and performs no soft-delete/audit", async () => {
  findFirstMock.mockResolvedValue(SYSTEM_TEMPLATE)
  const res = await DELETE(req("DELETE"), ctx("tpl_sys"))
  expect(res.status).toBe(403)
  const body = await res.json()
  expect(body.error).toMatch(/read-only/i)
  expect(updateMock).not.toHaveBeenCalled()
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("DELETE on a CUSTOM template soft-deletes (sets deletedAt) and audits", async () => {
  findFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  updateMock.mockResolvedValue({ ...CUSTOM_TEMPLATE, deletedAt: new Date() })

  const res = await DELETE(req("DELETE"), ctx())
  expect(res.status).toBe(200)

  expect(updateMock).toHaveBeenCalledWith({
    where: { id: "tpl1" },
    data: { deletedAt: expect.any(Date) },
  })

  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      action: "DOCUMENT_TEMPLATE_DELETED",
      entity: "DocumentTemplate",
      entityId: "tpl1",
      oldValue: expect.objectContaining({ name: "Settlement Letter" }),
    })
  )
})
