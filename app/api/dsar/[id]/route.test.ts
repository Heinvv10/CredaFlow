import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const requireApiRoleMock = vi.fn()
const dsarFindFirstMock = vi.fn()
const dsarUpdateManyMock = vi.fn()
const auditLogCreateMock = vi.fn()
const queryRawMock = vi.fn()
const transactionMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (role: string) => requireApiRoleMock(role),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) =>
    cb({ id: "tenant-a" }),
}))
// lib/audit is deliberately NOT mocked: the audit row is asserted where the
// real writer lands it, on the transaction's auditLog.create. The root
// client's auditLog refuses, so an audit row written outside the
// transaction fails the test instead of committing apart from the change.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    dataSubjectRequest: {
      findFirst: (args: unknown) => dsarFindFirstMock(args),
      updateMany: (args: unknown) => dsarUpdateManyMock(args),
    },
    auditLog: { create: () => { throw new Error("audit written outside the transaction") } },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))

import { PATCH } from "./route"

type Dsar = { id: string; tenantId: string; status: string; completedAt: Date | null; response: string | null }
type Where = { id: string; tenantId?: string }

let dsars: Dsar[]
// A lookup that omits the caller's tenant finds the other tenant's row, as the
// table itself would: only the where clause keeps tenant B out.
const matching = (where: Where) => dsars.filter((row) =>
  row.id === where.id && (where.tenantId === undefined || row.tenantId === where.tenantId))

function patch(id: string, body: unknown) {
  return PATCH(new NextRequest(`http://localhost/api/dsar/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) })
}

const nothingWritten = () => {
  expect(dsarUpdateManyMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).not.toHaveBeenCalled()
}
const auditData = () => auditLogCreateMock.mock.calls[0][0].data

beforeEach(() => {
  vi.clearAllMocks()
  dsars = [
    { id: "dsar-a", tenantId: "tenant-a", status: "RECEIVED", completedAt: null, response: null },
    { id: "dsar-b", tenantId: "tenant-b", status: "RECEIVED", completedAt: null, response: null },
  ]
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-a", email: "admin@example.test" } })
  dsarFindFirstMock.mockImplementation(async ({ where }: { where: Where }) => {
    const [row] = matching(where)
    return row ? { ...row } : null
  })
  dsarUpdateManyMock.mockImplementation(async ({ where, data }: { where: Where; data: Partial<Dsar> }) => {
    const rows = matching(where)
    for (const row of rows) Object.assign(row, data)
    return { count: rows.length }
  })
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  queryRawMock.mockResolvedValue([])
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      $queryRaw: queryRawMock,
      dataSubjectRequest: { findFirst: dsarFindFirstMock, updateMany: dsarUpdateManyMock },
      auditLog: { create: auditLogCreateMock },
    }))
})

describe("PATCH /api/dsar/[id]", () => {
  it("requires ADMIN and refuses anyone else without writing", async () => {
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })

    const response = await patch("dsar-a", { status: "IN_PROGRESS" })

    expect(response.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
    nothingWritten()
  })

  it("audits a status change with the old and the new status", async () => {
    const response = await patch("dsar-a", { status: "IN_PROGRESS" })

    expect(response.status).toBe(200)
    expect(dsarUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "dsar-a", tenantId: "tenant-a" },
      data: { status: "IN_PROGRESS" },
    })
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1)
    expect(auditData()).toMatchObject({
      tenantId: "tenant-a",
      userId: "admin-a",
      userEmail: "admin@example.test",
      action: "DSAR_UPDATED",
      entity: "DataSubjectRequest",
      entityId: "dsar-a",
      oldValue: { status: "RECEIVED" },
      newValue: { status: "IN_PROGRESS" },
    })
  })

  it("answers 404 to another tenant's request, exactly as to one that does not exist, writing nothing", async () => {
    const foreign = await patch("dsar-b", { status: "COMPLETED" })
    const missing = await patch("dsar-nobody", { status: "COMPLETED" })

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    expect(dsars[1].status).toBe("RECEIVED")
    nothingWritten()
  })

  it("audits a completion with the completedAt it stamps, and not the response's words", async () => {
    const response = await patch("dsar-a", { status: "COMPLETED", response: "Synthetic response" })

    expect(response.status).toBe(200)
    const completedAt = dsars[0].completedAt
    expect(completedAt).toBeInstanceOf(Date)
    expect(auditData()).toMatchObject({
      oldValue: { status: "RECEIVED", completedAt: null },
      newValue: { status: "COMPLETED", completedAt: completedAt?.toISOString(), responseChanged: true },
    })
    expect(JSON.stringify(auditData())).not.toContain("Synthetic response")
  })

  it("answers 400 to a completedAt that is null or not a date, writing nothing", async () => {
    // new Date(null) is 1970-01-01: stored, it would falsify the POPIA response timing.
    for (const completedAt of [null, "not-a-date", 0]) {
      const response = await patch("dsar-a", { completedAt })
      expect(response.status, JSON.stringify(completedAt)).toBe(400)
    }
    expect(transactionMock).not.toHaveBeenCalled()
    expect(dsars[0].completedAt).toBeNull()
    nothingWritten()
  })

  it("keeps the first completedAt when a completed request is completed again", async () => {
    const first = new Date("2026-09-01T08:00:00.000Z")
    Object.assign(dsars[0], { status: "COMPLETED", completedAt: first })

    const response = await patch("dsar-a", { status: "COMPLETED", response: "Synthetic follow-up" })

    expect(response.status).toBe(200)
    expect(dsarUpdateManyMock.mock.calls[0][0].data).toEqual({ status: "COMPLETED", response: "Synthetic follow-up" })
    expect(dsars[0].completedAt).toBe(first)
    expect(auditData().newValue).not.toHaveProperty("completedAt")
  })

  it("stamps completedAt on a refusal, which answers the request as much as a completion does", async () => {
    await patch("dsar-a", { status: "REFUSED" })

    expect(dsars[0].completedAt).toBeInstanceOf(Date)
    expect(auditData()).toMatchObject({ oldValue: { completedAt: null }, newValue: { status: "REFUSED", completedAt: dsars[0].completedAt?.toISOString() } })
  })

  it("keeps completedAt on a move between two final statuses", async () => {
    const first = new Date("2026-09-01T08:00:00.000Z")
    Object.assign(dsars[0], { status: "COMPLETED", completedAt: first })

    await patch("dsar-a", { status: "REFUSED" })

    expect(dsarUpdateManyMock.mock.calls[0][0].data).toEqual({ status: "REFUSED" })
    expect(dsars[0].completedAt).toBe(first)
  })

  it("clears completedAt when a completed request is reopened, and stamps a new one when it completes again", async () => {
    const first = new Date("2026-09-01T08:00:00.000Z")
    Object.assign(dsars[0], { status: "COMPLETED", completedAt: first })

    await patch("dsar-a", { status: "IN_PROGRESS" })
    expect(dsars[0].completedAt).toBeNull()
    expect(auditData()).toMatchObject({
      oldValue: { status: "COMPLETED", completedAt: first.toISOString() },
      newValue: { status: "IN_PROGRESS", completedAt: null },
    })

    await patch("dsar-a", { status: "COMPLETED" })
    expect(dsars[0].completedAt).toBeInstanceOf(Date)
    expect(dsars[0].completedAt).not.toBe(first)
  })

  it("leaves completedAt alone on a move between two open statuses", async () => {
    await patch("dsar-a", { status: "IN_PROGRESS" })

    expect(dsarUpdateManyMock.mock.calls[0][0].data).toEqual({ status: "IN_PROGRESS" })
  })

  it("stores a completedAt sent in the body, over the stamp and over the clear", async () => {
    await patch("dsar-a", { status: "COMPLETED", completedAt: "2026-09-02T10:00:00.000Z" })
    expect(dsars[0].completedAt).toEqual(new Date("2026-09-02T10:00:00.000Z"))

    await patch("dsar-a", { status: "IN_PROGRESS", completedAt: "2026-09-03T10:00:00.000Z" })
    expect(dsars[0].completedAt).toEqual(new Date("2026-09-03T10:00:00.000Z"))
  })

  it("answers 400 to a PATCH that changes nothing, with no transaction and no audit row", async () => {
    for (const body of [{}, { unknownField: "x" }]) {
      expect((await patch("dsar-a", body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(transactionMock).not.toHaveBeenCalled()
    nothingWritten()
  })

  it("locks the row before reading the values it audits as old", async () => {
    await patch("dsar-a", { status: "IN_PROGRESS" })

    expect(queryRawMock).toHaveBeenCalledTimes(1)
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(dsarFindFirstMock.mock.invocationCallOrder[0])
  })

  it("does not answer 200 when the audit row cannot be written", async () => {
    auditLogCreateMock.mockRejectedValue(new Error("audit store down"))

    await expect(patch("dsar-a", { status: "IN_PROGRESS" })).rejects.toThrow("audit store down")
  })
})
