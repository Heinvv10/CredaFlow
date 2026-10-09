/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const listTemplatesMock = vi.fn()
const createTemplateMock = vi.fn()
const logAuditMock = vi.fn()
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: unknown) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/documents/catalogue", () => ({ listTemplates: (tenantId: unknown) => listTemplatesMock(tenantId) }))
vi.mock("@/lib/prisma", () => ({
  prisma: { documentTemplate: { create: (args: unknown) => createTemplateMock(args) } },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (args: unknown) => logAuditMock(args),
  AuditAction: {
    DOCUMENT_TEMPLATE_CREATED: "DOCUMENT_TEMPLATE_CREATED",
    DOCUMENT_TEMPLATE_UPDATED: "DOCUMENT_TEMPLATE_UPDATED",
    DOCUMENT_TEMPLATE_DELETED: "DOCUMENT_TEMPLATE_DELETED",
  },
}))

import { GET, POST } from "./route"

function postReq(body: object) {
  return new NextRequest("http://x/api/documents/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "LOAN_ADMIN" } })
  listTemplatesMock.mockResolvedValue([])
  createTemplateMock.mockImplementation(async (args: any) => ({ id: "tpl_new", ...args.data }))
  logAuditMock.mockResolvedValue(undefined)
})

it("returns 401 and does not call listTemplates when unauthenticated", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await GET(new NextRequest("http://x/api/documents/templates"))
  expect(res.status).toBe(401)
  expect(listTemplatesMock).not.toHaveBeenCalled()
})

it("returns 200 with templates for an authorized LOAN_ADMIN", async () => {
  listTemplatesMock.mockResolvedValue([{ id: "tpl1", key: "settlement_letter", name: "Settlement Letter" }])
  const res = await GET(new NextRequest("http://x/api/documents/templates"))
  expect(res.status).toBe(200)
  expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
  expect(listTemplatesMock).toHaveBeenCalledWith("t1")
  const body = await res.json()
  expect(body).toEqual({ templates: [{ id: "tpl1", key: "settlement_letter", name: "Settlement Letter" }] })
})

it("POST returns 401 and does not create when unauthenticated", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await POST(postReq({ name: "My Custom Doc" }))
  expect(res.status).toBe(401)
  expect(createTemplateMock).not.toHaveBeenCalled()
})

it("POST creates a CUSTOM template with a slugified key and audits the create", async () => {
  const res = await POST(postReq({ name: "My Custom Doc", category: "Collections" }))
  expect(res.status).toBe(201)

  expect(createTemplateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      tenantId: "t1",
      key: "my_custom_doc",
      name: "My Custom Doc",
      category: "Collections",
      kind: "CUSTOM",
      signingMethod: "NONE",
    }),
  })

  const body = await res.json()
  expect(body).toEqual(expect.objectContaining({ id: "tpl_new", kind: "CUSTOM", name: "My Custom Doc" }))

  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      action: "DOCUMENT_TEMPLATE_CREATED",
      entity: "DocumentTemplate",
      entityId: "tpl_new",
    })
  )
})

it("POST honours an explicitly provided key instead of slugifying the name", async () => {
  await POST(postReq({ name: "My Custom Doc", key: "explicit_key" }))
  expect(createTemplateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({ key: "explicit_key" }),
  })
})

it("POST 422s when name is missing and does not create", async () => {
  const res = await POST(postReq({ category: "Collections" }))
  expect(res.status).toBe(422)
  expect(createTemplateMock).not.toHaveBeenCalled()
  expect(logAuditMock).not.toHaveBeenCalled()
})
