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
    crmActivity: { findFirst: vi.fn() },
    crossSellOpportunity: { create: vi.fn() },
  },
}))

import { verifyCronSecret } from "@/lib/cron-auth"
import { prisma } from "@/lib/prisma"
import { POST } from "./route"

const req = () => new NextRequest(new URL("http://localhost/api/cron/dormant-clients"))

const dormant = (id: string, open: unknown[] = []) => ({ id, firstName: "Synthetic", lastName: id, crossSellOpportunities: open })

const clientsByTenant: Record<string, unknown[]> = {
  "tenant-a": [dormant("a-1"), dormant("a-2")],
  "tenant-b": [dormant("b-1")],
}

describe("POST /api/cron/dormant-clients", () => {
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
    ;(prisma.crmActivity.findFirst as any).mockResolvedValue(null)
    ;(prisma.crossSellOpportunity.create as any).mockResolvedValue({})
  })

  it("refuses a caller without the cron secret and touches nothing", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await POST(req())).status).toBe(401)
    expect(prisma.tenant.findMany).not.toHaveBeenCalled()
  })

  it("sweeps every tenant, naming that tenant on the client read, the activity check and each opportunity it creates", async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(m.frames).toEqual(["tenant-a", "tenant-b"])

    // The exclusions are business rules: a blacklisted or deceased client, or
    // one with an active loan, is never re-engaged.
    const clientWheres = (prisma.client.findMany as any).mock.calls.map(([args]: any[]) => args.where)
    expect(clientWheres).toEqual([
      { tenantId: "tenant-a", blacklisted: false, deceasedAt: null, loans: { none: { status: "ACTIVE" } } },
      { tenantId: "tenant-b", blacklisted: false, deceasedAt: null, loans: { none: { status: "ACTIVE" } } },
    ])
    const activityWheres = (prisma.crmActivity.findFirst as any).mock.calls.map(([args]: any[]) => args.where)
    expect(activityWheres).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", clientId: "a-1" }),
      expect.objectContaining({ tenantId: "tenant-a", clientId: "a-2" }),
      expect.objectContaining({ tenantId: "tenant-b", clientId: "b-1" }),
    ])
    const created = (prisma.crossSellOpportunity.create as any).mock.calls.map(([args]: any[]) => args.data)
    expect(created).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", clientId: "a-1", type: "PERSONAL_LOAN", status: "PENDING" }),
      expect.objectContaining({ tenantId: "tenant-a", clientId: "a-2", type: "PERSONAL_LOAN", status: "PENDING" }),
      expect.objectContaining({ tenantId: "tenant-b", clientId: "b-1", type: "PERSONAL_LOAN", status: "PENDING" }),
    ])
    expect(created[0].notes).toBe(
      "Re-engagement: client has had no activity for 90+ days and has no active loans. Consider reaching out with a relevant loan offer."
    )
  })

  // Both crons create sales opportunities, so a suspended or still-provisioning
  // lender is not swept.
  it("sweeps only ACTIVE tenants", async () => {
    await POST(req())
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE" } }))
  })

  it("sums processed and flagged across tenants and reports each tenant", async () => {
    const res = await POST(req())
    expect(await res.json()).toEqual({
      ok: true,
      processed: 3,
      flagged: 3,
      perTenant: [
        { tenantId: "tenant-a", processed: 2, flagged: 2 },
        { tenantId: "tenant-b", processed: 1, flagged: 1 },
      ],
    })
  })

  it("skips a client with recent activity or an open re-engagement opportunity", async () => {
    ;(prisma.crmActivity.findFirst as any).mockImplementation(async ({ where }: any) => (where.clientId === "a-1" ? { id: "act" } : null))
    clientsByTenant["tenant-b"] = [dormant("b-1", [{ id: "opp" }])]
    try {
      const res = await POST(req())
      expect(await res.json()).toMatchObject({ processed: 3, flagged: 1 })
      expect((prisma.crossSellOpportunity.create as any).mock.calls.map(([a]: any[]) => a.data.clientId)).toEqual(["a-2"])
    } finally {
      clientsByTenant["tenant-b"] = [dormant("b-1")]
    }
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
      ok: false,
      processed: 1,
      flagged: 1,
      perTenant: [
        { tenantId: "tenant-a", error: "connection reset" },
        { tenantId: "tenant-b", processed: 1, flagged: 1 },
      ],
    })
    expect((prisma.crossSellOpportunity.create as any).mock.calls.map(([a]: any[]) => a.data.tenantId)).toEqual(["tenant-b"])
    expect(console.error).toHaveBeenCalled()
  })

  it("answers 500 when the tenant list cannot be read", async () => {
    ;(prisma.tenant.findMany as any).mockRejectedValue(new Error("db down"))
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Cron job failed" })
    expect(console.error).toHaveBeenCalledWith("[cron/dormant-clients] failed:", expect.any(Error))
  })
})
