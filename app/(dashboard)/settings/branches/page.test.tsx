import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactElement } from "react"

const { requireMinRole, getResolvedTenantId, notFound, tenantFindFirst, branchFindMany, userFindMany } = vi.hoisted(() => ({
  requireMinRole: vi.fn(),
  getResolvedTenantId: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }),
  tenantFindFirst: vi.fn(),
  branchFindMany: vi.fn(),
  userFindMany: vi.fn(),
}))

vi.mock("next/navigation", () => ({ notFound }))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId }))
// tenant.findFirst answers some other ACTIVE tenant: a page that picks "the
// first active tenant" lists that tenant's branches instead of the request's.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findFirst: tenantFindFirst },
    branch: { findMany: branchFindMany },
    user: { findMany: userFindMany },
  },
}))
vi.mock("@/components/layout/Header", () => ({ Header: () => null }))
vi.mock("./BranchesSettingsClient", () => ({ BranchesSettingsClient: () => null }))

import BranchesSettingsPage from "./page"
import { BranchesSettingsClient } from "./BranchesSettingsClient"

const MANAGERS = [{ id: "staff-a", name: "Synthetic Manager", email: "manager@example.test" }]

beforeEach(() => {
  vi.clearAllMocks()
  requireMinRole.mockResolvedValue({ id: "admin-a", tenantId: "tenant-a" })
  getResolvedTenantId.mockResolvedValue("tenant-a")
  tenantFindFirst.mockResolvedValue({ id: "tenant-other" })
  branchFindMany.mockResolvedValue([])
  userFindMany.mockResolvedValue(MANAGERS)
})

describe("/settings/branches", () => {
  it("requires ADMIN", async () => {
    await BranchesSettingsPage()
    expect(requireMinRole).toHaveBeenCalledWith("ADMIN")
  })

  it("lists the request's tenant's branches, and only its active staff as managers", async () => {
    const page = (await BranchesSettingsPage()) as ReactElement<{ children: ReactElement[] }>

    expect(branchFindMany.mock.calls[0][0].where).toEqual({ tenantId: "tenant-a" })
    expect(userFindMany.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-a", active: true, role: { in: ["BRANCH_MANAGER", "LOAN_ADMIN", "SUPER_ADMIN", "ADMIN"] },
    })
    const list = page.props.children.find((child) => child.type === BranchesSettingsClient) as ReactElement<{ managers: unknown }>
    expect(list.props.managers).toEqual(MANAGERS)
  })

  it("is 404, reading nothing, when the host resolved to a tenant that is not the session's", async () => {
    getResolvedTenantId.mockResolvedValue("tenant-b")

    await expect(BranchesSettingsPage()).rejects.toThrow("NEXT_NOT_FOUND")
    expect(branchFindMany).not.toHaveBeenCalled()
    expect(userFindMany).not.toHaveBeenCalled()
  })
})
