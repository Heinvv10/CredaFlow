import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { leadFindMany, applicationAggregate, applicationFindMany } = vi.hoisted(() => ({
  leadFindMany: vi.fn(),
  applicationAggregate: vi.fn(),
  applicationFindMany: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({ user: { id: "staff-1" } }),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: async (
    _req: NextRequest,
    callback: (tenant: { id: string }) => Promise<Response>,
  ) => callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: { findMany: leadFindMany },
    loanApplication: {
      aggregate: applicationAggregate,
      findMany: applicationFindMany,
    },
  },
}))

import { GET } from "./route"

describe("GET /api/crm/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const now = new Date()
    leadFindMany.mockResolvedValue([
      {
        id: "lead-complete",
        firstName: "Exact",
        lastName: "Conversion",
        status: "CONVERTED",
        source: "WEBSITE",
        lostReason: null,
        requestedAmount: 500_000,
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
        convertedToClientId: "client-1",
        convertedToApplicationId: "app-exact",
        conversionRecoveryRequired: false,
      },
      {
        id: "lead-incomplete",
        firstName: "Legacy",
        lastName: "Incomplete",
        status: "CONVERTED",
        source: "WEBSITE",
        lostReason: null,
        requestedAmount: 900_000,
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
        convertedToClientId: "client-1",
        convertedToApplicationId: null,
        conversionRecoveryRequired: true,
      },
      {
        id: "lead-stranded",
        firstName: "Legacy",
        lastName: "Stranded",
        status: "CONVERTED",
        source: "MANUAL",
        lostReason: null,
        requestedAmount: 300_000,
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
        convertedToClientId: null,
        convertedToApplicationId: null,
        conversionRecoveryRequired: true,
      },
    ])
    applicationAggregate.mockResolvedValue({ _sum: { appliedAmount: 500_000 } })
    applicationFindMany.mockResolvedValue([{ id: "app-exact", appliedAmount: 500_000 }])
  })

  it("counts and values only complete conversions by their exact application", async () => {
    const response = await GET(new NextRequest("https://staging.example.test/api/crm/analytics"))
    expect(response.status).toBe(200)
    const body = await response.json()

    expect(body.funnel).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "CONVERTED", count: 1 }),
      expect.objectContaining({ status: "INCOMPLETE", count: 1 }),
      expect.objectContaining({ status: "STRANDED", count: 1 }),
    ]))
    expect(body.thisMonth.converted).toBe(1)
    expect(body.bySource).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "WEBSITE", total: 2, converted: 1 }),
      expect.objectContaining({ source: "MANUAL", total: 1, converted: 0 }),
    ]))
    expect(body.revenueFromLeads).toBe(500_000)
    expect(applicationAggregate).toHaveBeenCalledWith({
      _sum: { appliedAmount: true },
      where: { tenantId: "tenant-1", id: { in: ["app-exact"] } },
    })
    expect(applicationFindMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", id: { in: ["app-exact"] } },
      select: { id: true, appliedAmount: true },
    })
  })
})
