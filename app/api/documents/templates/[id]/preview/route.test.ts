/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const templateFindFirstMock = vi.fn()
const clientFindFirstMock = vi.fn()
const tenantFindUniqueOrThrowMock = vi.fn()
const loanFindFirstMock = vi.fn()
const loanApplicationFindFirstMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: unknown) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }),
}))
const lenderIdentityMocks = vi.hoisted(() => ({ get: vi.fn(), find: vi.fn() }))
vi.mock("@/lib/config/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/identity")>()
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  const identity = actual.parseLenderIdentity(VALID_LENDER_COLUMNS)
  lenderIdentityMocks.get.mockResolvedValue(identity)
  lenderIdentityMocks.find.mockResolvedValue(identity)
  return {
    ...actual,
    getLenderIdentity: (...args: unknown[]) => lenderIdentityMocks.get(...args),
    findLenderIdentity: (...args: unknown[]) => lenderIdentityMocks.find(...args),
  }
})
vi.mock("@/lib/prisma", () => ({
  prisma: {
    documentTemplate: {
      findFirst: (args: unknown) => templateFindFirstMock(args),
    },
    client: {
      findFirst: (args: unknown) => clientFindFirstMock(args),
    },
    tenant: {
      findUniqueOrThrow: (args: unknown) => tenantFindUniqueOrThrowMock(args),
    },
    loan: {
      findFirst: (args: unknown) => loanFindFirstMock(args),
    },
    loanApplication: {
      findFirst: (args: unknown) => loanApplicationFindFirstMock(args),
    },
  },
}))

import { POST } from "./route"

function ctx(id = "tpl1") {
  return { params: Promise.resolve({ id }) }
}

function req(body?: object) {
  return new NextRequest(`http://x/api/documents/templates/tpl1/preview`, {
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
  deletedAt: null,
}

const SYSTEM_TEMPLATE = { ...CUSTOM_TEMPLATE, id: "tpl_sys", kind: "SYSTEM" }

const SAMPLE_CLIENT = {
  id: "c1",
  firstName: "Thabo",
  lastName: "M",
  idNumber: "9001016000087",
  email: "thabo@example.com",
  phone: "0821234567",
  addressLine1: "12 Main Street",
  city: "Pretoria",
}

const SAMPLE_TENANT = { id: "t1", slug: "acme", name: "Acme Lending" }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "LOAN_ADMIN" } })
  templateFindFirstMock.mockResolvedValue(CUSTOM_TEMPLATE)
  clientFindFirstMock.mockResolvedValue(SAMPLE_CLIENT)
  tenantFindUniqueOrThrowMock.mockResolvedValue(SAMPLE_TENANT)
  loanFindFirstMock.mockResolvedValue(null)
  loanApplicationFindFirstMock.mockResolvedValue(null)
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
  expect(clientFindFirstMock).not.toHaveBeenCalled()
})

it("returns 403 on a SYSTEM template and performs no lookups", async () => {
  templateFindFirstMock.mockResolvedValue(SYSTEM_TEMPLATE)
  const res = await POST(req({ bodyHtml: "<p>hi</p>" }), ctx("tpl_sys"))
  expect(res.status).toBe(403)
  const body = await res.json()
  expect(body.error).toMatch(/read-only/i)
  expect(clientFindFirstMock).not.toHaveBeenCalled()
})

it("returns 422 when bodyHtml is missing", async () => {
  const res = await POST(req({}), ctx())
  expect(res.status).toBe(422)
  expect(clientFindFirstMock).not.toHaveBeenCalled()
})

it("returns 200 with { html, missing } built from the sample client, resolving known tokens", async () => {
  const res = await POST(
    req({ bodyHtml: "<p>Hi {{client.fullName}}, ref {{loan.reference}}</p>" }),
    ctx()
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.html).toBe("<p>Hi Thabo M, ref {{loan.reference}}</p>")
  expect(body.missing).toEqual(["loan.reference"])
})

it("uses the given clientId to look up the sample client, scoped to the tenant", async () => {
  await POST(req({ bodyHtml: "<p>hi</p>", clientId: "c2" }), ctx())
  expect(clientFindFirstMock).toHaveBeenCalledWith({ where: { id: "c2", tenantId: "t1" } })
})

it("falls back to the tenant's first client (by createdAt) when no clientId is given", async () => {
  await POST(req({ bodyHtml: "<p>hi</p>" }), ctx())
  expect(clientFindFirstMock).toHaveBeenCalledWith({
    where: { tenantId: "t1" },
    orderBy: { createdAt: "asc" },
  })
})

it("looks up the client's most recent loan and application, scoped to the tenant", async () => {
  await POST(req({ bodyHtml: "<p>hi</p>" }), ctx())
  expect(loanFindFirstMock).toHaveBeenCalledWith({
    where: { clientId: "c1", tenantId: "t1" },
    orderBy: { createdAt: "desc" },
  })
  expect(loanApplicationFindFirstMock).toHaveBeenCalledWith({
    where: { clientId: "c1", tenantId: "t1" },
    orderBy: { createdAt: "desc" },
    include: { product: true },
  })
})

it("handles no client on file gracefully: returns every token found as missing, without crashing", async () => {
  clientFindFirstMock.mockResolvedValue(null)
  const res = await POST(
    req({ bodyHtml: "Hi {{client.fullName}}, {{tenant.legalName}}" }),
    ctx()
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.html).toBe("Hi {{client.fullName}}, {{tenant.legalName}}")
  expect(body.missing).toEqual(["client.fullName", "tenant.legalName"])
  expect(tenantFindUniqueOrThrowMock).not.toHaveBeenCalled()
  expect(loanFindFirstMock).not.toHaveBeenCalled()
})

it("handles an unknown clientId gracefully: falls back to the no-client path", async () => {
  clientFindFirstMock.mockResolvedValue(null)
  const res = await POST(req({ bodyHtml: "{{client.fullName}}", clientId: "bogus" }), ctx())
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.missing).toEqual(["client.fullName"])
})
