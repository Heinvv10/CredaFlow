import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const requireApiRoleMock = vi.fn()
const canDoMock = vi.fn()
const userFindFirstMock = vi.fn()
const branchFindManyMock = vi.fn()
const branchCreateMock = vi.fn()
const auditLogCreateMock = vi.fn()
const transactionMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (role: string) => requireApiRoleMock(role),
  canDo: (role: string, permission: string) => canDoMock(role, permission),
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
    branch: {
      findMany: (args: unknown) => branchFindManyMock(args),
      create: (args: unknown) => branchCreateMock(args),
    },
    auditLog: { create: () => { throw new Error("audit written outside the transaction") } },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))

import { GET, POST } from "./route"

const USERS = [
  { id: "manager-a", tenantId: "tenant-a", role: "BRANCH_MANAGER" },
  { id: "officer-a", tenantId: "tenant-a", role: "CREDIT_OFFICER" },
  { id: "manager-b", tenantId: "tenant-b", role: "BRANCH_MANAGER" },
]
type UserWhere = { id: string; tenantId?: string; role?: { in: string[] } }

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/branches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
}

const VALID = { name: "Synthetic Branch", code: "syn" }

const nothingWritten = () => {
  expect(transactionMock).not.toHaveBeenCalled()
  expect(branchCreateMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-a", email: "admin@example.test", role: "ADMIN" } })
  canDoMock.mockReturnValue(true)
  // A lookup that omits the caller's tenant finds the other tenant's row, as
  // the table itself would: only the where clause keeps tenant B out.
  userFindFirstMock.mockImplementation(async ({ where }: { where: UserWhere }) =>
    USERS.find((row) =>
      row.id === where.id &&
      (where.tenantId === undefined || row.tenantId === where.tenantId) &&
      (where.role === undefined || where.role.in.includes(row.role))) ?? null)
  branchFindManyMock.mockResolvedValue([])
  branchCreateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "branch-1", ...data }))
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
    cb({ branch: { create: branchCreateMock }, auditLog: { create: auditLogCreateMock } }))
})

describe("POST /api/branches", () => {
  it("requires ADMIN with manage_branches and refuses anyone else without writing", async () => {
    requireApiRoleMock.mockResolvedValueOnce({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await post(VALID)).status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")

    canDoMock.mockReturnValue(false)
    expect((await post(VALID)).status).toBe(403)
    expect(canDoMock).toHaveBeenCalledWith("ADMIN", "manage_branches")
    nothingWritten()
  })

  it("creates the branch with the caller's own manager and audits it", async () => {
    const response = await post({ ...VALID, managerId: "manager-a" })

    expect(response.status).toBe(201)
    expect(branchCreateMock).toHaveBeenCalledTimes(1)
    expect(branchCreateMock.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-a", name: "Synthetic Branch", code: "SYN", managerId: "manager-a",
    })
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1)
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-a",
        userId: "admin-a",
        userEmail: "admin@example.test",
        action: "BRANCH_CREATED",
        entity: "Branch",
        entityId: "branch-1",
        newValue: { name: "Synthetic Branch", code: "SYN", managerId: "manager-a" },
      }),
    })
  })

  it("creates a branch with no manager without looking anyone up", async () => {
    const response = await post(VALID)

    expect(response.status).toBe(201)
    expect(userFindFirstMock).not.toHaveBeenCalled()
    expect(branchCreateMock.mock.calls[0][0].data.managerId).toBeNull()
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1)
  })

  it("refuses another tenant's managerId exactly as it refuses one that does not exist, writing nothing", async () => {
    const foreign = await post({ ...VALID, managerId: "manager-b" })
    const missing = await post({ ...VALID, managerId: "manager-nobody" })

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    nothingWritten()
  })

  it("refuses as manager a staff member the page would not offer, writing nothing", async () => {
    const response = await post({ ...VALID, managerId: "officer-a" })

    expect(response.status).toBe(404)
    expect(userFindFirstMock.mock.calls[0][0].where).toMatchObject({ tenantId: "tenant-a", active: true })
    nothingWritten()
  })

  it("answers 400 to a managerId that is not a string, before any lookup", async () => {
    const response = await post({ ...VALID, managerId: { not: "" } })

    expect(response.status).toBe(400)
    expect(userFindFirstMock).not.toHaveBeenCalled()
    nothingWritten()
  })

  it("does not answer 201 when the audit row cannot be written", async () => {
    auditLogCreateMock.mockRejectedValue(new Error("audit store down"))

    await expect(post(VALID)).rejects.toThrow("audit store down")
  })
})

describe("GET /api/branches", () => {
  it("lists only the caller's tenant", async () => {
    const response = await GET(new NextRequest("http://localhost/api/branches"))

    expect(response.status).toBe(200)
    expect(branchFindManyMock.mock.calls[0][0].where).toEqual({ tenantId: "tenant-a" })
  })
})
