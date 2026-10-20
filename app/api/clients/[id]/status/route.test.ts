import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const clientFindFirstMock = vi.fn()
const clientUpdateMock = vi.fn()
const logAuditMock = vi.fn()
const contactUpdateManyMock = vi.fn()
const tx = {
  client: { update: (a: unknown) => clientUpdateMock(a) },
  contact: { updateMany: (a: unknown) => contactUpdateManyMock(a) },
}

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (r: string) => requireApiRoleMock(r) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: (a: unknown) => clientFindFirstMock(a) },
    $transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: (...a: unknown[]) => logAuditMock(...a),
}))

import { PATCH } from "./route"

const ctx = { params: Promise.resolve({ id: "c1" }) }
const request = (body: unknown) =>
  new NextRequest("http://x/api/clients/c1/status", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "manager@example.test" } })
  clientFindFirstMock.mockResolvedValue({
    id: "c1", firstName: "Themba", lastName: "Cele", blacklisted: false, deceasedAt: null,
  })
  clientUpdateMock.mockImplementation((a: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "c1", ...a.data })
  )
  logAuditMock.mockResolvedValue(undefined)
  contactUpdateManyMock.mockResolvedValue({ count: 1 })
})

describe("PATCH /api/clients/[id]/status — authorization", () => {
  it("requires a role senior to the CREDIT_OFFICER who can create clients", async () => {
    await PATCH(request({ deceased: true, reason: "Death certificate received" }), ctx)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
  })

  it("writes nothing when the role check fails", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response("forbidden", { status: 403 }) })

    const res = await PATCH(request({ deceased: true, reason: "x" }), ctx)

    expect(res.status).toBe(403)
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/clients/[id]/status — recording a death", () => {
  it("stamps deceasedAt and stores the reason", async () => {
    const res = await PATCH(request({ deceased: true, reason: "Death certificate received" }), ctx)

    expect(res.status).toBe(200)
    const arg = clientUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(arg.data.deceasedAt).toBeInstanceOf(Date)
    expect(arg.data.deceasedReason).toBe("Death certificate received")
  })

  it("scopes the update to the caller's tenant", async () => {
    await PATCH(request({ deceased: true, reason: "Death certificate received" }), ctx)
    expect(clientFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1", tenantId: "t1" } })
    )
  })

  it("writes an audit row naming the action", async () => {
    await PATCH(request({ deceased: true, reason: "Death certificate received" }), ctx)

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLIENT_DECEASED_RECORDED", entity: "Client", entityId: "c1" }),
      tx,
    )
  })

  it("clears deceasedAt when reversing the record", async () => {
    clientFindFirstMock.mockResolvedValue({
      id: "c1", firstName: "T", lastName: "C", blacklisted: false, deceasedAt: new Date("2026-08-01"),
    })

    await PATCH(request({ deceased: false, reason: "Recorded against the wrong client" }), ctx)

    const arg = clientUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(arg.data.deceasedAt).toBeNull()
  })
})

describe("PATCH /api/clients/[id]/status — a death silences every messaging channel", () => {
  it("blocks the client's Contact in the same transaction, so the inbox cannot message the estate", async () => {
    await PATCH(request({ deceased: true, reason: "Death certificate received" }), ctx)

    expect(contactUpdateManyMock).toHaveBeenCalledOnce()
    const arg = contactUpdateManyMock.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> }
    expect(arg.where).toEqual({ tenantId: "t1", clientId: "c1", status: { not: "BLOCKED" } })
    expect(arg.data).toMatchObject({ status: "BLOCKED", blockedReason: "DECEASED: client death recorded" })
    expect(arg.data.blockedAt).toBeInstanceOf(Date)
  })

  it("records how many contacts it blocked in the audit row", async () => {
    contactUpdateManyMock.mockResolvedValue({ count: 2 })
    await PATCH(request({ deceased: true, reason: "Death certificate received" }), ctx)

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ contactsBlocked: 2 }) }),
      tx,
    )
  })

  it("leaves a Contact blocked for another reason alone when the death is reversed, and re-opens only the ones it blocked", async () => {
    clientFindFirstMock.mockResolvedValue({
      id: "c1", firstName: "T", lastName: "C", blacklisted: false, deceasedAt: new Date("2026-08-01"),
    })
    await PATCH(request({ deceased: false, reason: "Recorded against the wrong client" }), ctx)

    const arg = contactUpdateManyMock.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> }
    expect(arg.where).toEqual({ tenantId: "t1", clientId: "c1", status: "BLOCKED", blockedReason: "DECEASED: client death recorded" })
    expect(arg.data).toEqual({ status: "CLIENT", blockedAt: null, blockedReason: null })
  })

  it("does not touch Contacts when blacklisting", async () => {
    await PATCH(request({ blacklisted: true, reason: "Confirmed first-party fraud" }), ctx)
    expect(contactUpdateManyMock).not.toHaveBeenCalled()
  })

  it("rolls everything back and writes no audit row when the Contact block fails", async () => {
    contactUpdateManyMock.mockRejectedValue(new Error("db down"))
    const res = await PATCH(request({ deceased: true, reason: "x" }), ctx)

    expect(res.status).toBe(500)
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/clients/[id]/status — blacklisting", () => {
  it("sets blacklisted and its reason", async () => {
    const res = await PATCH(request({ blacklisted: true, reason: "Confirmed first-party fraud" }), ctx)

    expect(res.status).toBe(200)
    const arg = clientUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(arg.data.blacklisted).toBe(true)
    expect(arg.data.blacklistReason).toBe("Confirmed first-party fraud")
  })

  it("writes its own audit action, distinct from a death", async () => {
    await PATCH(request({ blacklisted: true, reason: "Confirmed first-party fraud" }), ctx)
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLIENT_BLACKLISTED" }),
      tx,
    )
  })
})

describe("PATCH /api/clients/[id]/status — validation", () => {
  it("rejects a request that asserts nothing", async () => {
    const res = await PATCH(request({ reason: "just because" }), ctx)

    expect(res.status).toBe(422)
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("requires a reason when asserting a status", async () => {
    // The reason is the audit trail's only account of WHY credit was cut off.
    const res = await PATCH(request({ deceased: true }), ctx)

    expect(res.status).toBe(422)
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("404s for a client outside the caller's tenant", async () => {
    clientFindFirstMock.mockResolvedValue(null)

    const res = await PATCH(request({ deceased: true, reason: "x" }), ctx)

    expect(res.status).toBe(404)
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("does not write an audit row when the update itself fails", async () => {
    // An audit row claiming a status change that never landed is worse than
    // none: it is a false record in the trail auditors read.
    clientUpdateMock.mockRejectedValue(new Error("db down"))

    const res = await PATCH(request({ deceased: true, reason: "x" }), ctx)

    expect(res.status).toBe(500)
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})
