import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const requireApiRoleMock = vi.fn()
const clientFindFirstMock = vi.fn()
const dsarFindManyMock = vi.fn()
const dsarCreateMock = vi.fn()
const auditLogCreateMock = vi.fn()
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
    client: { findFirst: (args: unknown) => clientFindFirstMock(args) },
    dataSubjectRequest: {
      findMany: (args: unknown) => dsarFindManyMock(args),
      create: (args: unknown) => dsarCreateMock(args),
    },
    auditLog: { create: () => { throw new Error("audit written outside the transaction") } },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))

import { GET, POST } from "./route"

const CLIENTS = [
  { id: "client-a", tenantId: "tenant-a" },
  { id: "client-b", tenantId: "tenant-b" },
]

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/dsar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
}

const VALID = { clientId: "client-a", type: "ACCESS", description: "Synthetic request" }

const nothingWritten = () => {
  expect(transactionMock).not.toHaveBeenCalled()
  expect(dsarCreateMock).not.toHaveBeenCalled()
  expect(auditLogCreateMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-a", email: "admin@example.test" } })
  // A lookup that omits the caller's tenant finds the other tenant's row, as
  // the table itself would: only the where clause keeps tenant B out.
  clientFindFirstMock.mockImplementation(async ({ where }: { where: { id: string; tenantId?: string } }) =>
    CLIENTS.find((row) => row.id === where.id && (where.tenantId === undefined || row.tenantId === where.tenantId)) ?? null)
  dsarFindManyMock.mockResolvedValue([])
  dsarCreateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "dsar-1", ...data }))
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
    cb({ dataSubjectRequest: { create: dsarCreateMock }, auditLog: { create: auditLogCreateMock } }))
})

describe("POST /api/dsar", () => {
  it("requires ADMIN and refuses anyone else without writing", async () => {
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })

    const response = await post(VALID)

    expect(response.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
    nothingWritten()
  })

  it("creates the request for the caller's own client and audits it", async () => {
    const response = await post(VALID)

    expect(response.status).toBe(201)
    expect(dsarCreateMock).toHaveBeenCalledTimes(1)
    const { data } = dsarCreateMock.mock.calls[0][0]
    expect(data).toMatchObject({ tenantId: "tenant-a", clientId: "client-a", type: "ACCESS", status: "RECEIVED" })
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1)
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-a",
        userId: "admin-a",
        userEmail: "admin@example.test",
        action: "DSAR_CREATED",
        entity: "DataSubjectRequest",
        entityId: "dsar-1",
        newValue: {
          reference: data.reference, clientId: "client-a", type: "ACCESS",
          status: "RECEIVED", dueDate: data.dueDate.toISOString(),
        },
      }),
    })
  })

  it("keeps the request's own words out of the audit row", async () => {
    await post(VALID)

    expect(JSON.stringify(auditLogCreateMock.mock.calls[0][0])).not.toContain("Synthetic request")
  })

  it("refuses another tenant's clientId exactly as it refuses one that does not exist, writing nothing", async () => {
    const foreign = await post({ ...VALID, clientId: "client-b" })
    const missing = await post({ ...VALID, clientId: "client-nobody" })

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    nothingWritten()
  })

  it("answers 400 to a clientId that is not a string, before any lookup", async () => {
    const response = await post({ ...VALID, clientId: { not: "" } })

    expect(response.status).toBe(400)
    expect(clientFindFirstMock).not.toHaveBeenCalled()
    nothingWritten()
  })

  it("does not answer 201 when the audit row cannot be written", async () => {
    auditLogCreateMock.mockRejectedValue(new Error("audit store down"))

    await expect(post(VALID)).rejects.toThrow("audit store down")
  })
})

describe("GET /api/dsar", () => {
  it("lists only the caller's tenant, whatever clientId is asked for", async () => {
    const response = await GET(new NextRequest("http://localhost/api/dsar?clientId=client-b"))

    expect(response.status).toBe(200)
    expect(dsarFindManyMock.mock.calls[0][0].where).toEqual({ tenantId: "tenant-a", clientId: "client-b" })
  })
})
