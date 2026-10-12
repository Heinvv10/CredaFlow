import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findFirstMock = vi.fn()
const queryRawMock = vi.fn()
const txFindFirstMock = vi.fn()
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
    $queryRaw: (q: unknown) => queryRawMock(q),
    breachLog: { findFirst: (a: unknown) => txFindFirstMock(a), update: (a: unknown) => updateMock(a) },
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

// Free text that, in a real register, could name the people affected.
const CONTAINMENT_TEXT = "Synthetic Person's mailbox access revoked."

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
  findFirstMock.mockResolvedValue(stored)
  queryRawMock.mockResolvedValue([{ id: "breach-1" }])
  txFindFirstMock.mockResolvedValue(stored)
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
    expect(txFindFirstMock.mock.calls[0][0].where).toEqual({ id: "breach-1", tenantId: "tenant-1" })
    expect(updateMock.mock.calls[0][0]).toEqual({
      where: { id: "breach-1", tenantId: "tenant-1" },
      data: { status: "CONTAINED" },
    })
  })

  it("reads the values it replaces inside the transaction, after locking the row", async () => {
    // Read before the lock, two concurrent edits both audit the same stale
    // oldValue; the lock makes the second read wait for the first to commit.
    await PATCH(patch({ status: "CONTAINED" }), params)
    expect(queryRawMock).toHaveBeenCalledTimes(1)
    const lock = queryRawMock.mock.calls[0][0] as { sql: string; values: unknown[] }
    expect(lock.sql).toMatch(/FROM "BreachLog"\s+WHERE "id" = \? AND "tenantId" = \?\s+FOR UPDATE/)
    expect(lock.values).toEqual(["breach-1", "tenant-1"])
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(txFindFirstMock.mock.invocationCallOrder[0])
    expect(txFindFirstMock.mock.invocationCallOrder[0]).toBeLessThan(updateMock.mock.invocationCallOrder[0])
    expect(findFirstMock).not.toHaveBeenCalled()
  })

  it("answers 404 for an id that is not in the caller's tenant, changing and auditing nothing", async () => {
    queryRawMock.mockResolvedValue([])
    txFindFirstMock.mockResolvedValue(null)
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
    await PATCH(patch({ reportedToIC: true, reportedAt: "2026-09-03" }), params)
    const audit = auditCreateMock.mock.calls[0][0].data
    expect(audit.oldValue).toEqual({ reportedToIC: false, reportedAt: null })
    expect(audit.newValue).toEqual({ reportedToIC: true, reportedAt: new Date("2026-09-03") })
  })

  it("audits that the containment action changed, never its text", async () => {
    txFindFirstMock.mockResolvedValue({ ...stored, containmentAction: "Synthetic Person's old note." })
    await PATCH(patch({ containmentAction: CONTAINMENT_TEXT, reportedToIC: true }), params)
    expect(updateMock.mock.calls[0][0].data).toEqual({ containmentAction: CONTAINMENT_TEXT, reportedToIC: true })
    const audit = auditCreateMock.mock.calls[0][0].data
    expect(audit.oldValue).toEqual({ reportedToIC: false })
    expect(audit.newValue).toEqual({ reportedToIC: true, containmentActionChanged: true })
    expect(JSON.stringify(audit)).not.toMatch(/Synthetic Person/)
  })

  it("records an unchanged containment action as unchanged", async () => {
    txFindFirstMock.mockResolvedValue({ ...stored, containmentAction: CONTAINMENT_TEXT })
    await PATCH(patch({ containmentAction: CONTAINMENT_TEXT }), params)
    expect(auditCreateMock.mock.calls[0][0].data.newValue).toEqual({ containmentActionChanged: false })
  })

  it("fails closed when the audit row cannot be written, and logs it without the row's text", async () => {
    // A database error can quote the failing row; the log must not.
    auditCreateMock.mockRejectedValue(new Error(`Failing row contains (${CONTAINMENT_TEXT})`))
    const res = await PATCH(patch({ status: "CONTAINED", containmentAction: CONTAINMENT_TEXT }), params)
    expect(res.status).toBe(500)
    expect(console.error).toHaveBeenCalledWith("[breach-log] update failed", expect.objectContaining({
      action: "BREACH_LOG_UPDATED", entity: "BreachLog", entityId: "breach-1", tenantId: "tenant-1", error: "Error",
    }))
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/Synthetic Person/)
  })

  it("refuses an edit that changes nothing, writing and auditing nothing", async () => {
    for (const body of [{}, { tenantId: "tenant-2" }, { note: "unrecognised" }]) {
      const res = await PATCH(patch(body), params)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(updateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("refuses malformed fields with 400, writing and auditing nothing", async () => {
    for (const body of [
      { status: "REOPENED" },
      { status: "open" },
      { status: 1 },
      { reportedToIC: "true" },
      { reportedAt: "not a date" },
      { reportedAt: 20260903 },
      { containmentAction: 5 },
    ]) {
      const res = await PATCH(patch(body), params)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    const res = await PATCH(new NextRequest(URL, { method: "PATCH", body: "{not json" }), params)
    expect(res.status).toBe(400)
    expect(updateMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("accepts clearing the containment action and the reported date", async () => {
    txFindFirstMock.mockResolvedValue({ ...stored, containmentAction: CONTAINMENT_TEXT, reportedAt: new Date("2026-09-03") })
    const res = await PATCH(patch({ containmentAction: null, reportedAt: null }), params)
    expect(res.status).toBe(200)
    expect(updateMock.mock.calls[0][0].data).toEqual({ containmentAction: null, reportedAt: null })
  })

  it("moves status only the way the register offers: OPEN on, CONTAINED to RESOLVED, RESOLVED nowhere", async () => {
    const moves: Array<[string, string, number]> = [
      ["OPEN", "CONTAINED", 200], ["OPEN", "RESOLVED", 200], ["CONTAINED", "RESOLVED", 200],
      ["OPEN", "OPEN", 409], ["CONTAINED", "OPEN", 409], ["CONTAINED", "CONTAINED", 409],
      ["RESOLVED", "OPEN", 409], ["RESOLVED", "CONTAINED", 409], ["RESOLVED", "RESOLVED", 409],
    ]
    for (const [from, to, status] of moves) {
      vi.clearAllMocks()
      txFindFirstMock.mockResolvedValue({ ...stored, status: from })
      const res = await PATCH(patch({ status: to }), params)
      expect(res.status, `${from} -> ${to}`).toBe(status)
      expect(updateMock).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
      expect(auditCreateMock).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
    }
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
