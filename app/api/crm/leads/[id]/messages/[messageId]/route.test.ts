import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const leadFindFirstMock = vi.fn()
const messageFindFirstMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: {
      findFirst: (a: unknown) => leadFindFirstMock(a),
    },
    message: {
      findFirst: (a: unknown) => messageFindFirstMock(a),
    },
  },
}))

import { GET } from "./route"

const ctx = { params: Promise.resolve({ id: "l1", messageId: "m1" }) }
function req() {
  return new NextRequest("http://x/api/crm/leads/l1/messages/m1")
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "READONLY" } })
  withTenantContextMock.mockImplementation((_req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }))
})

it("401 when the guard denies", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await GET(req(), ctx)
  expect(res.status).toBe(401)
  expect(leadFindFirstMock).not.toHaveBeenCalled()
})

it("400 when the lead has no contact", async () => {
  leadFindFirstMock.mockResolvedValue({ id: "l1", contact: null })
  const res = await GET(req(), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "lead has no contact" })
  expect(messageFindFirstMock).not.toHaveBeenCalled()
})

it("400 when the lead does not exist", async () => {
  leadFindFirstMock.mockResolvedValue(null)
  const res = await GET(req(), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "lead has no contact" })
})

it("200 {status} passthrough on a matching message", async () => {
  leadFindFirstMock.mockResolvedValue({ id: "l1", contact: { id: "ct1" } })
  messageFindFirstMock.mockResolvedValue({ status: "DELIVERED" })

  const res = await GET(req(), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: "DELIVERED" })
  expect(leadFindFirstMock).toHaveBeenCalledWith({
    where: { id: "l1", tenantId: "t1" },
    include: { contact: true },
  })
  expect(messageFindFirstMock).toHaveBeenCalledWith({
    where: { id: "m1", tenantId: "t1", conversation: { contactId: "ct1" } },
    select: { status: true, dispatchState: true, dispatchLeaseExpiresAt: true },
  })
})

it("surfaces a durable no-replay claim as reconciliation-required", async () => {
  leadFindFirstMock.mockResolvedValue({ id: "l1", contact: { id: "ct1" } })
  messageFindFirstMock.mockResolvedValue({
    status: "QUEUED",
    dispatchState: "AMBIGUOUS",
    dispatchLeaseExpiresAt: null,
  })

  const res = await GET(req(), ctx)
  expect(await res.json()).toEqual({ status: "RECONCILIATION_REQUIRED" })
})

it("404 when the message does not exist or belongs to another lead", async () => {
  leadFindFirstMock.mockResolvedValue({ id: "l1", contact: { id: "ct1" } })
  messageFindFirstMock.mockResolvedValue(null)

  const res = await GET(req(), ctx)
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: "message not found" })
})
