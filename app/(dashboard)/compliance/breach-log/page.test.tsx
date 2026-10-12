import { describe, it, expect, vi, beforeEach } from "vitest"

const { requireMinRole, getResolvedTenantId, breachLogFindMany, notFound } = vi.hoisted(() => ({
  requireMinRole: vi.fn(),
  getResolvedTenantId: vi.fn(),
  breachLogFindMany: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("next/navigation", () => ({ notFound }))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId }))
vi.mock("@/lib/prisma", () => ({ prisma: { breachLog: { findMany: breachLogFindMany } } }))

import BreachLogPage from "./page"

beforeEach(() => {
  vi.clearAllMocks()
  requireMinRole.mockResolvedValue({ id: "admin-1", tenantId: "tenant-1" })
  getResolvedTenantId.mockResolvedValue("tenant-1")
  breachLogFindMany.mockResolvedValue([])
})

describe("/compliance/breach-log", () => {
  it("requires LOAN_ADMIN", async () => {
    await BreachLogPage()
    expect(requireMinRole).toHaveBeenCalledWith("LOAN_ADMIN")
  })

  it("lists only the resolved tenant's entries", async () => {
    await BreachLogPage()
    expect(breachLogFindMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      orderBy: { incidentDate: "desc" },
    })
  })

  it("is not found, and reads nothing, for a session that belongs to another tenant", async () => {
    requireMinRole.mockResolvedValue({ id: "admin-2", tenantId: "tenant-2" })
    await expect(BreachLogPage()).rejects.toThrow("NEXT_NOT_FOUND")
    expect(breachLogFindMany).not.toHaveBeenCalled()
  })
})
