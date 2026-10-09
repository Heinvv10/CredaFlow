import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({ verify: vi.fn(), tenants: vi.fn(), sweep: vi.fn(), frames: [] as string[], current: null as string | null }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: m.verify }))
vi.mock("@/lib/tenant-scope", () => ({
  runWithTenant: async (t: string, fn: () => Promise<unknown>) => { m.frames.push(t); m.current = t; try { return await fn() } finally { m.current = null } },
}))
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findMany: m.tenants } } }))
vi.mock("@/lib/website-chat/handoff-sweep", () => ({ sweepHandoffs: m.sweep }))

import { GET } from "./route"

const req = () => new NextRequest("http://localhost/api/cron/website-chat-handoffs")
const none = { expired: 0, emailed: 0, failed: 0, released: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  m.frames.length = 0
  m.verify.mockReturnValue(null)
  m.tenants.mockResolvedValue([{ id: "t1" }, { id: "t2" }])
})

describe("GET /api/cron/website-chat-handoffs", () => {
  it("refuses a caller without the cron secret and touches nothing", async () => {
    m.verify.mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await GET(req())).status).toBe(401)
    expect(m.tenants).not.toHaveBeenCalled()
    expect(m.sweep).not.toHaveBeenCalled()
  })

  it("sweeps each tenant's hand-offs inside that tenant's frame", async () => {
    m.sweep.mockImplementation(async (tenantId: string) => { expect(m.current).toBe(tenantId); return tenantId === "t1" ? { expired: 2, emailed: 1, failed: 0, released: 3 } : none })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(m.frames).toEqual(["t1", "t2"])
    expect(m.sweep).toHaveBeenCalledWith("t1", expect.any(Date))
    expect(await res.json()).toMatchObject({ ok: true, perTenant: [{ tenantId: "t1", expired: 2, emailed: 1, failed: 0, released: 3 }, { tenantId: "t2", ...none }] })
  })

  it("returns a NON-2XX when a tenant throws, after trying the rest", async () => {
    // The scheduler treats only a non-2xx as a failure.
    m.sweep.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce({ ...none, expired: 1 })
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(m.sweep).toHaveBeenCalledTimes(2)
    expect(await res.json()).toMatchObject({ ok: false, perTenant: [{ tenantId: "t1", error: "connection reset" }, { tenantId: "t2", expired: 1 }] })
  })

  it("returns a NON-2XX when an alert email failed, even though nothing threw", async () => {
    m.sweep.mockResolvedValueOnce(none).mockResolvedValueOnce({ ...none, emailed: 1, failed: 1 })
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, perTenant: [{ tenantId: "t1" }, { tenantId: "t2", failed: 1 }] })
  })
})
