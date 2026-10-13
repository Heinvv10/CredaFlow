import { beforeEach, describe, expect, it, vi } from "vitest"

const { requireMinRole, getStaffTenantId, messageFindMany } = vi.hoisted(() => ({
  requireMinRole: vi.fn(),
  getStaffTenantId: vi.fn(),
  messageFindMany: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({ requireMinRole }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId }))
vi.mock("@/lib/prisma", () => ({
  prisma: { message: { findMany: messageFindMany } },
}))

import MessageReconciliationPage from "./page"

describe("MessageReconciliationPage authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireMinRole.mockResolvedValue({
      id: "loan-admin-1",
      email: "loan-admin@example.test",
      name: "Loan Admin",
      role: "LOAN_ADMIN",
    })
    getStaffTenantId.mockResolvedValue("tenant-1")
    messageFindMany.mockResolvedValue([])
  })

  it("uses the same LOAN_ADMIN hierarchy as the reconciliation API without a comms-agent flag", async () => {
    await MessageReconciliationPage({ searchParams: Promise.resolve({}) })

    expect(requireMinRole).toHaveBeenCalledOnce()
    expect(requireMinRole).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(messageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-1", status: "QUEUED" }),
    }))
  })
})
