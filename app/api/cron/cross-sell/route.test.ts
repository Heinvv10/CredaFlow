/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: vi.fn(async () => "tenant-a") }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findMany: vi.fn() },
    crossSellOpportunity: { count: vi.fn(), create: vi.fn() },
  },
}))

import { verifyCronSecret } from "@/lib/cron-auth"
import { prisma } from "@/lib/prisma"
import { POST } from "./route"

const req = () => new NextRequest(new URL("http://localhost/api/cron/cross-sell"))

const paid = (n: number) => Array.from({ length: n }, () => ({ status: "PAID" }))

describe("POST /api/cron/cross-sell", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyCronSecret).mockReturnValue(null as unknown as NextResponse)
    ;(prisma.client.findMany as any).mockResolvedValue([
      // MICRO with 3 paid instalments and no PERSONAL loan → PERSONAL_LOAN
      { id: "client-micro", loans: [{ id: "l1", principal: 100_000, product: { productType: "MICRO" }, repaymentSchedule: paid(3) }], insurancePolicies: [] },
      // PERSONAL over R20 000 with no credit life → CREDIT_LIFE
      { id: "client-personal", loans: [{ id: "l2", principal: 3_000_000, product: { productType: "PERSONAL" }, repaymentSchedule: [] }], insurancePolicies: [] },
    ])
    ;(prisma.crossSellOpportunity.count as any).mockResolvedValue(0)
    ;(prisma.crossSellOpportunity.create as any).mockResolvedValue({})
  })

  // CrossSellOpportunity is a tenant-scope model and a cron has no tenant
  // frame: a query without a tenantId throws missing-context, and one with
  // the wrong tenant would dedupe against another lender's rows.
  it("names the swept tenant on the duplicate check and on every opportunity it creates", async () => {
    const res = await POST(req())
    expect(await res.json()).toEqual({ evaluated: 2, created: 2 })

    const countWheres = (prisma.crossSellOpportunity.count as any).mock.calls.map(([args]: any[]) => args.where)
    expect(countWheres).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", clientId: "client-micro", type: "PERSONAL_LOAN" }),
      expect.objectContaining({ tenantId: "tenant-a", clientId: "client-personal", type: "CREDIT_LIFE" }),
    ])
    const created = (prisma.crossSellOpportunity.create as any).mock.calls.map(([args]: any[]) => args.data)
    expect(created).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", clientId: "client-micro", type: "PERSONAL_LOAN" }),
      expect.objectContaining({ tenantId: "tenant-a", clientId: "client-personal", type: "CREDIT_LIFE" }),
    ])
  })

  it("does not create an opportunity the tenant already has open", async () => {
    ;(prisma.crossSellOpportunity.count as any).mockResolvedValue(1)
    const res = await POST(req())
    expect(await res.json()).toEqual({ evaluated: 2, created: 0 })
    expect(prisma.crossSellOpportunity.create).not.toHaveBeenCalled()
  })
})
