import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findFirstMock = vi.fn()
const updateMock = vi.fn()
const auditCreateMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: string) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
// The real lib/audit.ts runs against this mock, so the audit row is asserted
// as written, on the transaction client the breach row was updated on.
vi.mock("@/lib/prisma", () => {
  const tx = {
    breachLog: { update: (a: unknown) => updateMock(a) },
    auditLog: { create: (a: unknown) => auditCreateMock(a) },
  }
  return {
    prisma: {
      breachLog: { findFirst: (a: unknown) => findFirstMock(a) },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  }
})

import { GET, PATCH } from "./route"

const URL = "https://staging.example.test/api/compliance/breach-log/breach-1"
const params = { params: Promise.resolve({ id: "breach-1" }) }
const get = () => new NextRequest(URL)
const patch = (body: unknown) => new NextRequest(URL, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const stored = {
  id: "breach-1",
  tenantId: "tenant-1",
  status: "OPEN",
  containmentAction: null,
  reportedToIC: false,
  reportedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
  findFirstMock.mockResolvedValue(stored)
  updateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...stored, ...data }))
  auditCreateMock.mockResolvedValue({})
})

describe("GET /api/compliance/breach-log/[id]", () => {
  it("reads the entry by id within the caller's tenant", async () => {
    const res = await GET(get(), params)
    expect(res.status).toBe(200)
    expect(findFirstMock).toHaveBeenCalledWith({ where: { id: "breach-1", tenantId: "tenant-1" } })
  })

  it("answers 404, not 403, for an id that is not in the caller's tenant", async () => {
    findFirstMock.mockResolvedValue(null)
    const res = await GET(get(), params)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Breach log not found" })
  })

  it("requires LOAN_ADMIN and reads nothing when the guard refuses", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    const res = await GET(get(), params)
    expect(res.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(findFirstMock).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/compliance/breach-log/[id]", () => {
  it("looks the entry up, and updates it, within the caller's tenant", async () => {
    const res = await PATCH(patch({ status: "CONTAINED" }), params)
    expect(res.status).toBe(200)
    expect(findFirstMock.mock.calls[0][0].where).toEqual({ id: "breach-1", tenantId: "tenant-1" })
    expect(updateMock.mock.calls[0][0]).toEqual({
      where: { id: "breach-1", tenantId: "tenant-1" },
      data: { status: "CONTAINED" },
    })
  })

  it("answers 404 for an id that is not in the caller's tenant, changing and auditing nothing", async () => {
    findFirstMock.mockResolvedValue(null)
    const res = await PATCH(patch({ status: "RESOLVED" }), params)
    expect(res.status).toBe(404)
    expect(updateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("cannot move an entry to another tenant", async () => {
    await PATCH(patch({ status: "CONTAINED", tenantId: "tenant-2" }), params)
    expect(updateMock.mock.calls[0][0].data).toEqual({ status: "CONTAINED" })
  })

  it("audits a status change with the old and the new value", async () => {
    await PATCH(patch({ status: "CONTAINED" }), params)
    expect(auditCreateMock).toHaveBeenCalledTimes(1)
    expect(auditCreateMock.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-1",
      userId: "admin-1",
      userEmail: "admin@example.test",
      action: "BREACH_LOG_UPDATED",
      entity: "BreachLog",
      entityId: "breach-1",
      oldValue: { status: "OPEN" },
      newValue: { status: "CONTAINED" },
    })
  })

  it("audits every field the edit changed, and only those", async () => {
    await PATCH(patch({ containmentAction: "Mailbox access revoked.", reportedToIC: true, reportedAt: "2026-09-03" }), params)
    const audit = auditCreateMock.mock.calls[0][0].data
    expect(audit.oldValue).toEqual({ containmentAction: null, reportedToIC: false, reportedAt: null })
    expect(audit.newValue).toEqual({
      containmentAction: "Mailbox access revoked.",
      reportedToIC: true,
      reportedAt: new Date("2026-09-03"),
    })
  })

  it("fails closed when the audit row cannot be written", async () => {
    auditCreateMock.mockRejectedValue(new Error("audit unavailable"))
    const res = await PATCH(patch({ status: "CONTAINED" }), params)
    expect(res.status).toBe(500)
  })

  it("requires LOAN_ADMIN and writes nothing when the guard refuses", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    const res = await PATCH(patch({ status: "CONTAINED" }), params)
    expect(res.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(updateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })
})
