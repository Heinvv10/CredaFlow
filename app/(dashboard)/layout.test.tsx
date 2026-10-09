import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  authMock,
  redirectMock,
  redirectStaleSessionMock,
  applicationCountMock,
  loanCountMock,
  opportunityCountMock,
  leadCountMock,
  queryRawMock,
  getTenantConfigMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  redirectMock: vi.fn(),
  redirectStaleSessionMock: vi.fn(),
  applicationCountMock: vi.fn(),
  loanCountMock: vi.fn(),
  opportunityCountMock: vi.fn(),
  leadCountMock: vi.fn(),
  queryRawMock: vi.fn(),
  getTenantConfigMock: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: redirectMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/auth-guards", () => ({
  redirectStaleSession: redirectStaleSessionMock,
}))
vi.mock("@/components/app-shell/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { count: applicationCountMock },
    loan: { count: loanCountMock },
    crossSellOpportunity: { count: opportunityCountMock },
    lead: { count: leadCountMock },
    $queryRaw: queryRawMock,
  },
}))
vi.mock("@/lib/tenant", () => ({
  getTenantConfig: getTenantConfigMock,
  resolveFeatureFlags: vi.fn(() => ({ featureCrm: false, featureIms: false, featureBureauSubmission: false })),
}))

import DashboardLayout from "./layout"

describe("dashboard tenant authority", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redirectStaleSessionMock.mockImplementation(() => {
      throw new Error("stale-session")
    })
    applicationCountMock.mockResolvedValue(0)
    loanCountMock.mockResolvedValue(0)
    opportunityCountMock.mockResolvedValue(0)
    leadCountMock.mockResolvedValue(0)
    // $queryRaw always resolves an array; returning undefined would make the
    // failure look like a bug in the badge rather than an unstubbed mock.
    queryRawMock.mockResolvedValue([{ count: BigInt(0) }])
    getTenantConfigMock.mockResolvedValue(null)
  })

  it("rejects a null-tenant staff session before any tenant data query", async () => {
    authMock.mockResolvedValue({
      user: {
        id: "staff-unassigned",
        email: "unassigned@example.invalid",
        name: "Unassigned",
        role: "LOAN_ADMIN",
        tenantId: null,
      },
    })

    await expect(DashboardLayout({ children: null }))
      .rejects.toThrow("stale-session")
    expect(applicationCountMock).not.toHaveBeenCalled()
    expect(loanCountMock).not.toHaveBeenCalled()
    expect(opportunityCountMock).not.toHaveBeenCalled()
    expect(leadCountMock).not.toHaveBeenCalled()
    expect(getTenantConfigMock).not.toHaveBeenCalled()
  })

  it("uses the authenticated staff tenant for sidebar and feature queries", async () => {
    authMock.mockResolvedValue({
      user: {
        id: "staff-1",
        email: "staff@example.invalid",
        name: "Staff",
        role: "LOAN_ADMIN",
        tenantId: "tenant-authoritative",
      },
    })

    await DashboardLayout({ children: null })

    for (const count of [
      applicationCountMock,
      loanCountMock,
      opportunityCountMock,
      leadCountMock,
    ]) {
      expect(count).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ tenantId: "tenant-authoritative" }),
      }))
    }

    // The unanswered-inbox badge is raw SQL, so it cannot be covered by the
    // objectContaining check above — but it is just as tenant-scoped, and a
    // sidebar badge leaking another tenant's conversation count is the same
    // defect as any other cross-tenant read.
    expect(queryRawMock).toHaveBeenCalled()
    const params = queryRawMock.mock.calls[0].slice(1)
    expect(params).toContain("tenant-authoritative")
    expect(getTenantConfigMock).toHaveBeenCalledWith("tenant-authoritative")
  })
})
