/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const templateFindFirstMock = vi.fn()
const versionAggregateMock = vi.fn()
const versionCreateMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: unknown) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    documentTemplate: {
      findFirst: (args: unknown) => templateFindFirstMock(args),
    },
    documentTemplateVersion: {
      aggregate: (args: unknown) => versionAggregateMock(args),
      create: (args: unknown) => versionCreateMock(args),
    },
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (args: unknown) => logAuditMock(args),
  AuditAction: {
    DOCUMENT_TEMPLATE_VERSION_CREATED: "DOCUMENT_TEMPLATE_VERSION_CREATED",
  },
}))

import { POST } from "./route"

function ctx(id = "tpl1") {
  return { params: Promise.resolve({ id }) }
}

function req(body?: object) {
  return new NextRequest(`http://x/api/documents/templates/tpl1/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

const CUSTOM_TEMPLATE = {
  id: "tpl1",
  tenantId: "t1",
  key: "settlement_letter",
  name: "Settlement Letter",
  kind: "CUSTOM",
  requiresApproval: false,
  deletedAt: null,
}

const SYSTEM_TEMPLATE = { ...CUSTOM_TEMPLATE, id: "tpl_sys", kind: "SYSTEM" }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "LOAN_ADMIN" } })
  logAuditMock.mockResolvedValue(undefined)
  versionAggregateMock.mockResolvedValue({ _max: { version: null } })
  versionCreateMock.mockImplementation((args: any) => Promise.resolve({ id: "v1", ...args.data }))
})

it("returns 401 when unauthenticated and does not touch the DB", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await POST(req({ bodyHtml: "<p>hi</p>" }), ctx())
  expect(res.status).toBe(401)
  expect(templateFindFirstMock).not.toHaveBeenCalled()
})

it("returns 404 when the template doesn't exist in this tenant", async () => {
  templateFindFirstMock.mockResolvedValue(null)
  const res = await POST(req({ bodyHtml: "<p>hi</p>" }), ctx())
  expect(res.status).toBe(404)
  expect(versionCreateMock).not.toHaveBeenCalled()
})

it("returns 403 on a SYSTEM parent template and performs no create/audit", async () => {
  templateFindFirstMock.mockResolvedValue(SYSTEM_TEMPLATE)
  const res = await POST(req({ bodyHtml: "<p>hi</p>" }), ctx("tpl_sys"))
  expect(res.status).toBe(403)
  const body = await res.json()
  expect(body.error).toMatch(/read-only/i)
  expect(versionCreateMock).not.toHaveBeenCalled()
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("returns 422 when bodyHtml is missing", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  const res = await POST(req({ notes: "no body" }), ctx())
  expect(res.status).toBe(422)
  expect(versionCreateMock).not.toHaveBeenCalled()
})

it("creates version 1 when no prior version exists", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  versionAggregateMock.mockResolvedValue({ _max: { version: null } })

  const res = await POST(req({ bodyHtml: "<p>Hello {{client.fullName}}</p>" }), ctx())
  expect(res.status).toBe(201)

  expect(versionCreateMock).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ templateId: "tpl1", version: 1, status: "DRAFT" }),
    })
  )
})

it("increments version to max+1 when prior versions exist", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  versionAggregateMock.mockResolvedValue({ _max: { version: 3 } })

  const res = await POST(req({ bodyHtml: "<p>hi</p>" }), ctx())
  expect(res.status).toBe(201)

  expect(versionCreateMock).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ version: 4 }) })
  )
})

it("extracts deduped tokensUsed from bodyHtml, in first-seen order", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)

  await POST(
    req({ bodyHtml: "<p>{{client.fullName}} owes {{loan.outstandingBalance}}, {{client.fullName}} again</p>" }),
    ctx()
  )

  expect(versionCreateMock).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        tokensUsed: ["client.fullName", "loan.outstandingBalance"],
      }),
    })
  )
})

it("stores createdById from the authenticated user and audits DOCUMENT_TEMPLATE_VERSION_CREATED", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)

  const res = await POST(req({ bodyHtml: "<p>hi</p>" }), ctx())
  expect(res.status).toBe(201)

  expect(versionCreateMock).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ createdById: "u1" }) })
  )

  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      action: "DOCUMENT_TEMPLATE_VERSION_CREATED",
      entity: "DocumentTemplateVersion",
      entityId: "v1",
    })
  )
})
