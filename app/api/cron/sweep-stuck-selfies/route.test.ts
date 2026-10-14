import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({ verify: vi.fn(), tenants: vi.fn(), sweep: vi.fn(), frames: [] as string[], current: null as string | null }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: m.verify }))
vi.mock("@/lib/tenant-scope", () => ({
  runWithTenant: async (t: string, fn: () => Promise<unknown>) => { m.frames.push(t); m.current = t; try { return await fn() } finally { m.current = null } },
}))
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findMany: m.tenants } } }))
vi.mock("@/lib/kyc/selfie-sweeper.server", () => ({ sweepStuckSelfies: m.sweep }))

import { GET } from "./route"

const req = () => new NextRequest("http://localhost/api/cron/sweep-stuck-selfies")

beforeEach(() => {
  vi.clearAllMocks()
  m.frames.length = 0
  m.verify.mockReturnValue(null)
  m.tenants.mockResolvedValue([{ id: "t1" }, { id: "t2" }])
})

describe("GET /api/cron/sweep-stuck-selfies", () => {
  it("refuses a caller without the cron secret and touches nothing", async () => {
    m.verify.mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await GET(req())).status).toBe(401)
    expect(m.tenants).not.toHaveBeenCalled()
    expect(m.sweep).not.toHaveBeenCalled()
  })

  it("sweeps each tenant inside that tenant's frame", async () => {
    m.sweep.mockImplementation(async (tenantId: string) => { expect(m.current).toBe(tenantId); return { swept: tenantId === "t1" ? 2 : 0, failed: 0 } })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(m.frames).toEqual(["t1", "t2"])
    expect(m.sweep).toHaveBeenCalledWith("t1", expect.any(Date))
    expect(await res.json()).toMatchObject({ ok: true, perTenant: [{ tenantId: "t1", swept: 2, failed: 0 }, { tenantId: "t2", swept: 0, failed: 0 }] })
  })

  it("returns a NON-2XX when a row failed inside an otherwise healthy tenant", async () => {
    m.sweep.mockResolvedValueOnce({ swept: 3, failed: 1 }).mockResolvedValueOnce({ swept: 0, failed: 0 })
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, perTenant: [{ tenantId: "t1", swept: 3, failed: 1 }, { tenantId: "t2", swept: 0, failed: 0 }] })
  })

  it("returns a NON-2XX when a tenant fails, after trying the rest", async () => {
    m.sweep.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce({ swept: 1, failed: 0 })
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(m.sweep).toHaveBeenCalledTimes(2)
    expect(await res.json()).toMatchObject({ ok: false, perTenant: [{ tenantId: "t1", error: "connection reset" }, { tenantId: "t2", swept: 1, failed: 0 }] })
  })
})
