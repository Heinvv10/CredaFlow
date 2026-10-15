/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({ frames: [] as string[], current: null as string | null }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn() }))
vi.mock("@/lib/tenant-scope", () => ({
  runWithTenant: async (t: string, fn: () => Promise<unknown>) => { m.frames.push(t); m.current = t; try { return await fn() } finally { m.current = null } },
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findMany: vi.fn() },
    client: { findMany: vi.fn() },
    crossSellOpportunity: { count: vi.fn(), create: vi.fn() },
  },
}))

import { verifyCronSecret } from "@/lib/cron-auth"
import { prisma } from "@/lib/prisma"
import { POST } from "./route"

const req = () => new NextRequest(new URL("http://localhost/api/cron/cross-sell"))

const paid = (n: number) => Array.from({ length: n }, () => ({ status: "PAID" }))

// MICRO with 3 paid instalments and no PERSONAL loan → PERSONAL_LOAN
const microClient = (id: string) => ({ id, loans: [{ id: `${id}-l`, principal: 100_000, product: { productType: "MICRO" }, repaymentSchedule: paid(3) }], insurancePolicies: [] })
// PERSONAL over R20 000 with no credit life → CREDIT_LIFE
const personalClient = (id: string) => ({ id, loans: [{ id: `${id}-l`, principal: 3_000_000, product: { productType: "PERSONAL" }, repaymentSchedule: [] }], insurancePolicies: [] })

const clientsByTenant: Record<string, unknown[]> = {
  "tenant-a": [microClient("a-micro"), personalClient("a-personal")],
  "tenant-b": [microClient("b-micro")],
}

describe("POST /api/cron/cross-sell", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.frames.length = 0
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.mocked(verifyCronSecret).mockReturnValue(null as unknown as NextResponse)
    ;(prisma.tenant.findMany as any).mockResolvedValue([{ id: "tenant-a" }, { id: "tenant-b" }])
    ;(prisma.client.findMany as any).mockImplementation(async ({ where }: any) => {
      expect(m.current).toBe(where.tenantId)
      return clientsByTenant[where.tenantId] ?? []
    })
    ;(prisma.crossSellOpportunity.count as any).mockResolvedValue(0)
    ;(prisma.crossSellOpportunity.create as any).mockResolvedValue({})
  })

  it("refuses a caller without the cron secret and touches nothing", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await POST(req())).status).toBe(401)
    expect(prisma.tenant.findMany).not.toHaveBeenCalled()
  })

  // CrossSellOpportunity is a tenant-scope model and each tenant's sweep runs
  // in that tenant's frame: a query naming the wrong tenant would dedupe
  // against another lender's rows.
  it("sweeps every tenant, naming that tenant on the client read, duplicate check and each opportunity it creates", async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(m.frames).toEqual(["tenant-a", "tenant-b"])

    const clientWheres = (prisma.client.findMany as any).mock.calls.map(([args]: any[]) => args.where)
    expect(clientWheres).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", blacklisted: false, deceasedAt: null }),
      expect.objectContaining({ tenantId: "tenant-b", blacklisted: false, deceasedAt: null }),
    ])
    const countWheres = (prisma.crossSellOpportunity.count as any).mock.calls.map(([args]: any[]) => args.where)
    expect(countWheres).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", clientId: "a-micro", type: "PERSONAL_LOAN" }),
      expect.objectContaining({ tenantId: "tenant-a", clientId: "a-personal", type: "CREDIT_LIFE" }),
      expect.objectContaining({ tenantId: "tenant-b", clientId: "b-micro", type: "PERSONAL_LOAN" }),
    ])
    const created = (prisma.crossSellOpportunity.create as any).mock.calls.map(([args]: any[]) => args.data)
    expect(created).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", clientId: "a-micro", type: "PERSONAL_LOAN" }),
      expect.objectContaining({ tenantId: "tenant-a", clientId: "a-personal", type: "CREDIT_LIFE" }),
      expect.objectContaining({ tenantId: "tenant-b", clientId: "b-micro", type: "PERSONAL_LOAN" }),
    ])
  })

  // Both crons create sales opportunities, so a suspended or still-provisioning
  // lender is not swept.
  it("sweeps only ACTIVE tenants", async () => {
    await POST(req())
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE" } }))
  })

  it("sums evaluated and created across tenants and reports each tenant", async () => {
    const res = await POST(req())
    expect(await res.json()).toEqual({
      evaluated: 3,
      created: 3,
      perTenant: [
        { tenantId: "tenant-a", evaluated: 2, created: 2 },
        { tenantId: "tenant-b", evaluated: 1, created: 1 },
      ],
    })
  })

  it("returns a NON-2XX when a tenant fails, after sweeping the rest", async () => {
    // The scheduler treats only a non-2xx as a failure.
    ;(prisma.client.findMany as any).mockImplementation(async ({ where }: any) => {
      if (where.tenantId === "tenant-a") throw new Error("connection reset")
      return clientsByTenant[where.tenantId]
    })
    const res = await POST(req())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      evaluated: 1,
      created: 1,
      perTenant: [
        { tenantId: "tenant-a", error: "connection reset" },
        { tenantId: "tenant-b", evaluated: 1, created: 1 },
      ],
    })
    expect((prisma.crossSellOpportunity.create as any).mock.calls.map(([a]: any[]) => a.data.tenantId)).toEqual(["tenant-b"])
  })

  it("does not create an opportunity the tenant already has open", async () => {
    ;(prisma.crossSellOpportunity.count as any).mockResolvedValue(1)
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ evaluated: 3, created: 0 })
    expect(prisma.crossSellOpportunity.create).not.toHaveBeenCalled()
  })

  it("answers 500 when the tenant list cannot be read", async () => {
    ;(prisma.tenant.findMany as any).mockRejectedValue(new Error("db down"))
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Cron job failed" })
    expect(console.error).toHaveBeenCalledWith("[cron/cross-sell] failed:", expect.any(Error))
  })
})
