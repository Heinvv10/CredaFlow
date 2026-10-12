import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const requireApiRoleMock = vi.fn()
const userFindFirstMock = vi.fn()
const complaintFindFirstMock = vi.fn()
const complaintUpdateManyMock = vi.fn()
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
    user: { findFirst: (args: unknown) => userFindFirstMock(args) },
    complaint: {
      findFirst: (args: unknown) => complaintFindFirstMock(args),
      updateMany: (args: unknown) => complaintUpdateManyMock(args),
    },
    auditLog: { create: () => { throw new Error("audit written outside the transaction") } },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))

import { GET, PATCH } from "./route"

type Complaint = {
  id: string
  tenantId: string
  status: string
  assignedToId: string | null
  outcome: string | null
  acknowledgedAt: Date | null
  resolvedAt: Date | null
  resolution: string | null
}
const open = (id: string, tenantId: string): Complaint => ({
  id, tenantId, status: "OPEN", assignedToId: null, outcome: null,
  acknowledgedAt: null, resolvedAt: null, resolution: null,
})

let complaints: Complaint[]
const USERS = [
  { id: "staff-a", tenantId: "tenant-a" },
  { id: "staff-b", tenantId: "tenant-b" },
]
type Where = { id: string; tenantId?: string }
// A lookup that omits the caller's tenant finds the other tenant's row, as the
// table itself would: only the where clause keeps tenant B out.
const matches = (row: { id: string; tenantId: string }, where: Where) =>
  row.id === where.id && (where.tenantId === undefined || row.tenantId === where.tenantId)

const context = (id: string) => ({ params: Promise.resolve({ id }) })
function patch(id: string, body: unknown) {
  return PATCH(new NextRequest(`http://localhost/api/complaints/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), context(id))
}

const nothingWritten = () => {
  expect(complaintUpdateManyMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).not.toHaveBeenCalled()
}
const auditData = () => auditLogCreateMock.mock.calls[0][0].data

beforeEach(() => {
  vi.clearAllMocks()
  complaints = [open("complaint-a", "tenant-a"), open("complaint-b", "tenant-b")]
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-a", email: "admin@example.test" } })
  userFindFirstMock.mockImplementation(async ({ where }: { where: Where }) =>
    USERS.find((user) => matches(user, where)) ?? null)
  complaintFindFirstMock.mockImplementation(async ({ where }: { where: Where }) => {
    const row = complaints.find((candidate) => matches(candidate, where))
    return row ? { ...row } : null
  })
  complaintUpdateManyMock.mockImplementation(async ({ where, data }: { where: Where; data: Partial<Complaint> }) => {
    const rows = complaints.filter((row) => matches(row, where))
    for (const row of rows) Object.assign(row, data)
    return { count: rows.length }
  })
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  queryRawMock.mockResolvedValue([])
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      $queryRaw: queryRawMock,
      complaint: { findFirst: complaintFindFirstMock, updateMany: complaintUpdateManyMock },
      auditLog: { create: auditLogCreateMock },
    }))
})

describe("PATCH /api/complaints/[id]", () => {
  it("requires LOAN_ADMIN and refuses anyone else without writing", async () => {
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })

    const response = await patch("complaint-a", { status: "ESCALATED" })

    expect(response.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    nothingWritten()
  })

  it("audits a status change with the old and the new status", async () => {
    const response = await patch("complaint-a", { status: "ESCALATED" })

    expect(response.status).toBe(200)
    expect(complaintUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "complaint-a", tenantId: "tenant-a" },
      data: { status: "ESCALATED" },
    })
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1)
    expect(auditData()).toMatchObject({
      tenantId: "tenant-a",
      userId: "admin-a",
      userEmail: "admin@example.test",
      action: "COMPLAINT_UPDATED",
      entity: "Complaint",
      entityId: "complaint-a",
      oldValue: { status: "OPEN" },
      newValue: { status: "ESCALATED" },
    })
  })

  it("answers 404 to another tenant's complaint, exactly as to one that does not exist, writing nothing", async () => {
    const foreign = await patch("complaint-b", { status: "CLOSED" })
    const missing = await patch("complaint-nobody", { status: "CLOSED" })

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    expect(complaints.find((row) => row.id === "complaint-b")?.status).toBe("OPEN")
    nothingWritten()
  })

  it("audits an assignment to the caller's own staff", async () => {
    const response = await patch("complaint-a", { assignedToId: "staff-a" })

    expect(response.status).toBe(200)
    expect(complaints[0].assignedToId).toBe("staff-a")
    expect(auditData()).toMatchObject({
      action: "COMPLAINT_UPDATED",
      oldValue: { assignedToId: null },
      newValue: { assignedToId: "staff-a" },
    })
  })

  it("refuses another tenant's assignedToId exactly as it refuses one that does not exist, writing nothing", async () => {
    const foreign = await patch("complaint-a", { assignedToId: "staff-b" })
    const missing = await patch("complaint-a", { assignedToId: "staff-nobody" })

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    expect(complaints[0].assignedToId).toBeNull()
    expect(transactionMock).not.toHaveBeenCalled()
    nothingWritten()
  })

  it("answers 400 to an assignedToId that is not a string, before any lookup", async () => {
    const response = await patch("complaint-a", { assignedToId: { not: "" } })

    expect(response.status).toBe(400)
    expect(userFindFirstMock).not.toHaveBeenCalled()
    nothingWritten()
  })

  it("unassigns on null without looking anyone up", async () => {
    complaints[0].assignedToId = "staff-a"

    const response = await patch("complaint-a", { assignedToId: null })

    expect(response.status).toBe(200)
    expect(userFindFirstMock).not.toHaveBeenCalled()
    expect(auditData()).toMatchObject({ oldValue: { assignedToId: "staff-a" }, newValue: { assignedToId: null } })
  })

  it("audits a close with its outcome and the resolvedAt it stamps, and not the resolution's words", async () => {
    const response = await patch("complaint-a", { status: "CLOSED", outcome: "UPHELD", resolution: "Synthetic resolution" })

    expect(response.status).toBe(200)
    const resolvedAt = complaints[0].resolvedAt
    expect(resolvedAt).toBeInstanceOf(Date)
    expect(auditData()).toMatchObject({
      oldValue: { status: "OPEN", outcome: null, resolvedAt: null },
      newValue: { status: "CLOSED", outcome: "UPHELD", resolvedAt: resolvedAt?.toISOString(), resolutionChanged: true },
    })
    expect(JSON.stringify(auditData())).not.toContain("Synthetic resolution")
  })

  it("stamps acknowledgedAt on the first move to UNDER_INVESTIGATION only", async () => {
    await patch("complaint-a", { status: "UNDER_INVESTIGATION" })
    const first = complaints[0].acknowledgedAt
    expect(first).toBeInstanceOf(Date)
    expect(auditData().newValue).toMatchObject({ status: "UNDER_INVESTIGATION", acknowledgedAt: first?.toISOString() })

    await patch("complaint-a", { status: "UNDER_INVESTIGATION" })
    expect(complaintUpdateManyMock.mock.calls[1][0].data).toEqual({ status: "UNDER_INVESTIGATION" })
    expect(complaints[0].acknowledgedAt).toBe(first)
  })

  it("locks the row before reading the values it audits as old", async () => {
    await patch("complaint-a", { status: "ESCALATED" })

    expect(queryRawMock).toHaveBeenCalledTimes(1)
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(complaintFindFirstMock.mock.invocationCallOrder[0])
  })

  it("does not answer 200 when the audit row cannot be written", async () => {
    auditLogCreateMock.mockRejectedValue(new Error("audit store down"))

    await expect(patch("complaint-a", { status: "ESCALATED" })).rejects.toThrow("audit store down")
  })
})

describe("GET /api/complaints/[id]", () => {
  it("answers 404 to another tenant's complaint", async () => {
    const own = await GET(new NextRequest("http://localhost/api/complaints/complaint-a"), context("complaint-a"))
    const foreign = await GET(new NextRequest("http://localhost/api/complaints/complaint-b"), context("complaint-b"))

    expect(own.status).toBe(200)
    expect(foreign.status).toBe(404)
  })
})
