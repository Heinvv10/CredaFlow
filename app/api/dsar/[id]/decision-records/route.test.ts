import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const requireApiRoleMock = vi.fn()
const dsarFindFirstMock = vi.fn()
const auditLogCreateMock = vi.fn()
const exportMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (role: string) => requireApiRoleMock(role),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-a" }),
}))
// lib/audit is not mocked: the row is asserted where the real writer lands it.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    dataSubjectRequest: { findFirst: (args: unknown) => dsarFindFirstMock(args) },
    auditLog: { create: (args: unknown) => auditLogCreateMock(args) },
  },
}))
vi.mock("@/lib/learning-loop/dsar-export", () => ({
  decisionRecordsForClient: (...args: unknown[]) => exportMock(...args),
}))

import { GET } from "./route"

type Where = { id: string; tenantId?: string }
const dsars = [
  { id: "dsar-a", tenantId: "tenant-a", reference: "DSAR-0001", clientId: "client-a" },
  { id: "dsar-b", tenantId: "tenant-b", reference: "DSAR-0002", clientId: "client-b" },
]

const get = (id: string) => GET(new NextRequest(`http://localhost/api/dsar/${id}/decision-records`), { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-a", email: "admin@example.test" } })
  dsarFindFirstMock.mockImplementation(async ({ where }: { where: Where }) =>
    dsars.find((d) => d.id === where.id && (where.tenantId === undefined || d.tenantId === where.tenantId)) ?? null)
  exportMock.mockResolvedValue([{ id: "rec-1", overrideReason: "Synthetic override reason." }])
})

describe("GET /api/dsar/[id]/decision-records", () => {
  it("is ADMIN only: a lesser role gets the guard's 403 and nothing is read or audited", async () => {
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    const res = await get("dsar-a")
    expect(res.status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
    expect(dsarFindFirstMock).not.toHaveBeenCalled()
    expect(exportMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("answers another lender's request as not found, exporting and auditing nothing", async () => {
    const res = await get("dsar-b")
    expect(res.status).toBe(404)
    expect(dsarFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "dsar-b", tenantId: "tenant-a" } }))
    expect(exportMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("downloads the client's records as JSON and audits the export without the records", async () => {
    const res = await get("dsar-a")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="decision-records-DSAR-0001.json"')
    expect(exportMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", "client-a")
    const body = JSON.parse(await res.text())
    expect(body).toMatchObject({ dsarReference: "DSAR-0001", clientId: "client-a", recordCount: 1, records: [{ id: "rec-1" }] })
    const { data } = auditLogCreateMock.mock.calls[0][0]
    expect(data).toMatchObject({
      tenantId: "tenant-a", userId: "admin-a", action: "DSAR_DECISION_RECORDS_EXPORTED", entity: "DataSubjectRequest", entityId: "dsar-a",
      newValue: { clientId: "client-a", recordCount: 1, format: "json" },
    })
    expect(JSON.stringify(data)).not.toContain("Synthetic override reason")
  })

  it("returns an empty list, not an error, for a client with no records", async () => {
    exportMock.mockResolvedValue([])
    const res = await get("dsar-a")
    expect(res.status).toBe(200)
    expect(JSON.parse(await res.text())).toMatchObject({ recordCount: 0, records: [] })
    expect(auditLogCreateMock.mock.calls[0][0].data.newValue).toMatchObject({ recordCount: 0 })
  })

  it("does not serve an export it could not record", async () => {
    auditLogCreateMock.mockRejectedValue(new Error("audit table unavailable"))
    await expect(get("dsar-a")).rejects.toThrow("audit table unavailable")
  })
})
