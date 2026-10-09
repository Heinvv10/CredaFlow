/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const templateFindFirstMock = vi.fn()
const versionFindFirstMock = vi.fn()
const versionFindManyMock = vi.fn()
const transactionMock = vi.fn()
const logAuditMock = vi.fn()

// tx-scoped mocks — asserted separately from the top-level (non-tx) mocks
// above so a test can tell "ran outside the transaction" from "ran inside it".
const txVersionUpdateManyMock = vi.fn()
const txVersionUpdateMock = vi.fn()
const txTemplateUpdateMock = vi.fn()
const txQueryRawMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: unknown) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    documentTemplate: {
      findFirst: (args: unknown) => templateFindFirstMock(args),
    },
    documentTemplateVersion: {
      findFirst: (args: unknown) => versionFindFirstMock(args),
      findMany: (args: unknown) => versionFindManyMock(args),
    },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (args: unknown) => logAuditMock(args),
  AuditAction: {
    DOCUMENT_TEMPLATE_VERSION_ARCHIVED: "DOCUMENT_TEMPLATE_VERSION_ARCHIVED",
    DOCUMENT_TEMPLATE_VERSION_PUBLISHED: "DOCUMENT_TEMPLATE_VERSION_PUBLISHED",
  },
}))

import { POST } from "./route"

function ctx(id = "tpl1", versionId = "v2") {
  return { params: Promise.resolve({ id, versionId }) }
}

function req() {
  return new NextRequest(`http://x/api/documents/templates/tpl1/versions/v2/publish`, { method: "POST" })
}

const tx = {
  $queryRaw: (...args: unknown[]) => txQueryRawMock(...args),
  documentTemplateVersion: {
    updateMany: (args: unknown) => txVersionUpdateManyMock(args),
    update: (args: unknown) => txVersionUpdateMock(args),
  },
  documentTemplate: {
    update: (args: unknown) => txTemplateUpdateMock(args),
  },
}

const CUSTOM_TEMPLATE = {
  id: "tpl1",
  tenantId: "t1",
  kind: "CUSTOM",
  requiresApproval: false,
  deletedAt: null,
}

const APPROVAL_REQUIRED_TEMPLATE = { ...CUSTOM_TEMPLATE, requiresApproval: true }
const SYSTEM_TEMPLATE = { ...CUSTOM_TEMPLATE, id: "tpl_sys", kind: "SYSTEM" }

const DRAFT_VERSION = {
  id: "v2",
  templateId: "tpl1",
  version: 2,
  status: "DRAFT",
  approvedById: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "LOAN_ADMIN" } })
  logAuditMock.mockResolvedValue(undefined)
  versionFindManyMock.mockResolvedValue([])
  txQueryRawMock.mockResolvedValue([{ "?column?": 1 }])
  txVersionUpdateManyMock.mockResolvedValue({ count: 0 })
  txVersionUpdateMock.mockImplementation((args: any) => Promise.resolve({ ...DRAFT_VERSION, ...args.data }))
  txTemplateUpdateMock.mockResolvedValue({ ...CUSTOM_TEMPLATE, currentVersionId: "v2" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx))
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
  expect(transactionMock).not.toHaveBeenCalled()
})

it("returns 403 on a SYSTEM parent template", async () => {
  templateFindFirstMock.mockResolvedValue(SYSTEM_TEMPLATE)
  const res = await POST(req(), ctx("tpl_sys"))
  expect(res.status).toBe(403)
  expect(transactionMock).not.toHaveBeenCalled()
})

it("returns 404 when the version doesn't exist under this template", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  versionFindFirstMock.mockResolvedValue(null)
  const res = await POST(req(), ctx())
  expect(res.status).toBe(404)
  expect(transactionMock).not.toHaveBeenCalled()
})

it("returns 409 when the template requires approval and the version has none, without running the transaction", async () => {
  templateFindFirstMock.mockResolvedValue(APPROVAL_REQUIRED_TEMPLATE)
  versionFindFirstMock.mockResolvedValue(DRAFT_VERSION)

  const res = await POST(req(), ctx())
  expect(res.status).toBe(409)
  const body = await res.json()
  expect(body.error).toMatch(/approval/i)
  expect(transactionMock).not.toHaveBeenCalled()
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("returns 409 when the approver tries to publish their own approval, without running the transaction", async () => {
  requireApiRoleMock.mockResolvedValue({ user: { id: "u2", email: "approver@b.c", role: "LOAN_ADMIN" } })
  templateFindFirstMock.mockResolvedValue(APPROVAL_REQUIRED_TEMPLATE)
  versionFindFirstMock.mockResolvedValue({ ...DRAFT_VERSION, approvedById: "u2", approvedAt: new Date() })

  const res = await POST(req(), ctx())
  expect(res.status).toBe(409)
  const body = await res.json()
  expect(body.error).toMatch(/approver cannot also publish/i)
  expect(transactionMock).not.toHaveBeenCalled()
  expect(logAuditMock).not.toHaveBeenCalled()
})

it("publishes an approval-required template once a different admin publishes the approved version", async () => {
  templateFindFirstMock.mockResolvedValue(APPROVAL_REQUIRED_TEMPLATE)
  versionFindFirstMock.mockResolvedValue({ ...DRAFT_VERSION, approvedById: "u2", approvedAt: new Date() })

  const res = await POST(req(), ctx())
  expect(res.status).toBe(200)
  expect(transactionMock).toHaveBeenCalledTimes(1)
})

it("activates the version, archives the prior active version, and repoints currentVersionId inside the transaction", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  versionFindFirstMock.mockResolvedValue(DRAFT_VERSION)
  versionFindManyMock.mockResolvedValue([{ id: "v1", templateId: "tpl1", version: 1, status: "ACTIVE" }])

  const res = await POST(req(), ctx())
  expect(res.status).toBe(200)

  expect(versionFindManyMock).toHaveBeenCalledWith({
    where: { templateId: "tpl1", status: "ACTIVE", id: { not: "v2" } },
  })

  expect(txVersionUpdateManyMock).toHaveBeenCalledWith({
    where: { templateId: "tpl1", status: "ACTIVE", id: { not: "v2" } },
    data: { status: "ARCHIVED" },
  })
  expect(txVersionUpdateMock).toHaveBeenCalledWith({
    where: { id: "v2" },
    data: { status: "ACTIVE", activatedById: "u1", activatedAt: expect.any(Date) },
  })
  expect(txTemplateUpdateMock).toHaveBeenCalledWith({
    where: { id: "tpl1" },
    data: { currentVersionId: "v2" },
  })

  // Audited: the archived prior version and the newly published version.
  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "DOCUMENT_TEMPLATE_VERSION_ARCHIVED",
      entity: "DocumentTemplateVersion",
      entityId: "v1",
    })
  )
  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      action: "DOCUMENT_TEMPLATE_VERSION_PUBLISHED",
      entity: "DocumentTemplateVersion",
      entityId: "v2",
    })
  )
  expect(logAuditMock).toHaveBeenCalledTimes(2)
})

it("acquires a row lock on the template as the first statement in the transaction, before the update/updateMany calls", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  versionFindFirstMock.mockResolvedValue(DRAFT_VERSION)

  const callOrder: string[] = []
  txQueryRawMock.mockImplementation(() => {
    callOrder.push("queryRaw")
    return Promise.resolve([{ "?column?": 1 }])
  })
  txVersionUpdateManyMock.mockImplementation(() => {
    callOrder.push("updateMany")
    return Promise.resolve({ count: 0 })
  })
  txVersionUpdateMock.mockImplementation((args: any) => {
    callOrder.push("update")
    return Promise.resolve({ ...DRAFT_VERSION, ...args.data })
  })
  txTemplateUpdateMock.mockImplementation(() => {
    callOrder.push("templateUpdate")
    return Promise.resolve({ ...CUSTOM_TEMPLATE, currentVersionId: "v2" })
  })

  const res = await POST(req(), ctx())
  expect(res.status).toBe(200)

  expect(txQueryRawMock).toHaveBeenCalledTimes(1)
  expect(callOrder[0]).toBe("queryRaw")
  expect(callOrder).toEqual(["queryRaw", "updateMany", "update", "templateUpdate"])
})

it("does not emit an ARCHIVED audit when there was no prior active version", async () => {
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  versionFindFirstMock.mockResolvedValue(DRAFT_VERSION)
  versionFindManyMock.mockResolvedValue([])

  const res = await POST(req(), ctx())
  expect(res.status).toBe(200)

  expect(logAuditMock).toHaveBeenCalledTimes(1)
  expect(logAuditMock).toHaveBeenCalledWith(
    expect.objectContaining({ action: "DOCUMENT_TEMPLATE_VERSION_PUBLISHED" })
  )
})
