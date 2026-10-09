/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const templateFindFirstMock = vi.fn()
const versionFindFirstMock = vi.fn()
const versionUpdateMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: unknown) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    documentTemplate: {
      findFirst: (args: unknown) => templateFindFirstMock(args),
    },
    documentTemplateVersion: {
      findFirst: (args: unknown) => versionFindFirstMock(args),
      update: (args: unknown) => versionUpdateMock(args),
    },
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (args: unknown) => logAuditMock(args),
  AuditAction: {
    DOCUMENT_TEMPLATE_VERSION_APPROVED: "DOCUMENT_TEMPLATE_VERSION_APPROVED",
  },
}))

import { POST } from "./route"

function ctx(id = "tpl1", versionId = "v1") {
  return { params: Promise.resolve({ id, versionId }) }
}

function req() {
  return new NextRequest(`http://x/api/documents/templates/tpl1/versions/v1/approve`, { method: "POST" })
}

const CUSTOM_TEMPLATE = {
  id: "tpl1",
  tenantId: "t1",
  kind: "CUSTOM",
  requiresApproval: true,
  deletedAt: null,
}

const SYSTEM_TEMPLATE = { ...CUSTOM_TEMPLATE, id: "tpl_sys", kind: "SYSTEM" }

const DRAFT_VERSION = {
  id: "v1",
  templateId: "tpl1",
  version: 1,
  status: "DRAFT",
  createdById: "author1",
  approvedById: null,
  approvedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "approver1", email: "a@b.c", role: "LOAN_ADMIN" } })
  logAuditMock.mockResolvedValue(undefined)
})

it("returns 401 when unauthenticated and does not touch the DB", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await POST(req(), ctx())
  expect(res.status).toBe(401)
  expect(templateFindFirstMock).not.toHaveBeenCalled()
})

it("returns 404 when the parent template doesn't exist in this tenant", async () => {
  templateFindFirstMock.mockResolvedValue(null)
  const res = await POST(req(), ctx())
  expect(res.status).toBe(404)
  expect(versionFindFirstMock).not.toHaveBeenCalled()
})

it("returns 403 on a SYSTEM parent template", async () => {
  templateFindFirstMock.mockResolvedValue(SYSTEM_TEMPLATE)
  const res = await POST(req(), ctx("tpl_sys"))
  expect(res.status).toBe(403)
  expect(versionFindFirstMock).not.toHaveBeenCalled()
})

it("returns 404 when the version doesn't exist under this template", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  versionFindFirstMock.mockResolvedValue(null)
  const res = await POST(req(), ctx())
  expect(res.status).toBe(404)
  expect(versionUpdateMock).not.toHaveBeenCalled()
})

it("returns 409 when the approver is the same user who authored the draft, without updating or auditing", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  versionFindFirstMock.mockResolvedValue({ ...DRAFT_VERSION, createdById: "approver1" })

  const res = await POST(req(), ctx())
  expect(res.status).toBe(409)
  const body = await res.json()
  expect(body.error).toMatch(/own draft/i)
  expect(versionUpdateMock).not.toHaveBeenCalled()
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("approves when a different admin than the author calls it, sets approvedById/approvedAt, and audits", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  versionFindFirstMock.mockResolvedValue(DRAFT_VERSION)
  versionUpdateMock.mockResolvedValue({ ...DRAFT_VERSION, approvedById: "approver1", approvedAt: new Date() })

  const res = await POST(req(), ctx())
  expect(res.status).toBe(200)

  expect(versionUpdateMock).toHaveBeenCalledWith({
    where: { id: "v1" },
    data: { approvedById: "approver1", approvedAt: expect.any(Date) },
  })

  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: "t1",
      userId: "approver1",
      action: "DOCUMENT_TEMPLATE_VERSION_APPROVED",
      entity: "DocumentTemplateVersion",
      entityId: "v1",
    })
  )
})
