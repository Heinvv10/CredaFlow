import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  requireMinRole,
  getStaffTenantId,
  auditFindMany,
  userFindMany,
  queryRaw,
} = vi.hoisted(() => ({
  requireMinRole: vi.fn(),
  getStaffTenantId: vi.fn(),
  auditFindMany: vi.fn(),
  userFindMany: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({ requireMinRole }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: auditFindMany },
    user: { findMany: userFindMany },
    $queryRaw: queryRaw,
  },
}))
vi.mock("@/components/layout/Header", () => ({ Header: () => null }))
vi.mock("./AuditLogClient", () => ({ AuditLogClient: () => null }))

import AuditLogPage from "./page"
import type { AuditTimelineEntry } from "@/lib/audit/document-access-timeline"

describe("audit log settings page", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireMinRole.mockResolvedValue({ id: "co-1", role: "ADMIN", tenantId: "tenant-1" })
    getStaffTenantId.mockResolvedValue("tenant-1")
    auditFindMany.mockResolvedValue([{
      id: "audit-1",
      userId: "staff-1",
      userEmail: "review@acme-lending.example",
      user: { name: "Review Officer", email: "review@acme-lending.example" },
      action: "COMPLIANCE_UPDATED",
      entity: "LoanApplication",
      entityId: "application-1",
      oldValue: null,
      newValue: { recklessLendingAssessed: true },
      ipAddress: "127.0.0.1",
      createdAt: new Date("2026-07-22T10:00:00.000Z"),
    }])
    queryRaw.mockResolvedValue([{
      id: "access-1",
      documentId: "document-1",
      accessorType: "staff",
      accessorId: "staff-1",
      action: "download",
      ipAddress: "127.0.0.2",
      userAgent: "test-agent",
      createdAt: new Date("2026-07-22T11:00:00.000Z"),
    }])
    userFindMany.mockResolvedValue([{
      id: "staff-1",
      name: "Review Officer",
      email: "review@acme-lending.example",
    }])
  })

  it("H4: hides STR case rows and STR_* actions from a LOAN_ADMIN", async () => {
    requireMinRole.mockResolvedValue({ id: "la-1", role: "LOAN_ADMIN", tenantId: "tenant-1" })
    await AuditLogPage()
    expect(auditFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", AND: [{ NOT: [{ entity: "SuspiciousReportCase" }, { action: { startsWith: "STR_" } }] }] },
    }))
  })

  it("merges tenant-scoped document access into the visible timeline with its actor", async () => {
    const page = await AuditLogPage()
    const children = page.props.children as Array<{
      props: { initialLogs?: AuditTimelineEntry[] }
    }>
    const timeline = children[1].props.initialLogs

    expect(requireMinRole).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(auditFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1" },
    }))
    expect(userFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1" },
    }))
    expect(timeline?.map((entry) => entry.action)).toEqual([
      "DOCUMENT_DOWNLOAD",
      "COMPLIANCE_UPDATED",
    ])
    expect(timeline?.[0]).toMatchObject({
      actorLabel: "review@acme-lending.example",
      entity: "ClientDocument",
      entityId: "document-1",
    })

    const sql = queryRaw.mock.calls[0][0] as { values: unknown[] }
    expect(sql.values).toEqual(["tenant-1", 100])
  })
})
