import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({ verify: vi.fn(), tenants: vi.fn(), close: vi.fn(), frames: [] as string[], current: null as string | null }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: m.verify }))
vi.mock("@/lib/tenant-scope", () => ({
  runWithTenant: async (t: string, fn: () => Promise<unknown>) => { m.frames.push(t); m.current = t; try { return await fn() } finally { m.current = null } },
}))
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findMany: m.tenants } } }))
vi.mock("@/lib/website-chat/auto-close", () => ({ closeIdleChats: m.close }))

import { GET } from "./route"

const req = () => new NextRequest("http://localhost/api/cron/website-chat-close")

beforeEach(() => {
  vi.clearAllMocks()
  m.frames.length = 0
  m.verify.mockReturnValue(null)
  m.tenants.mockResolvedValue([{ id: "t1" }, { id: "t2" }])
})

describe("GET /api/cron/website-chat-close", () => {
  it("refuses a caller without the cron secret and touches nothing", async () => {
    m.verify.mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await GET(req())).status).toBe(401)
    expect(m.tenants).not.toHaveBeenCalled()
    expect(m.close).not.toHaveBeenCalled()
  })

  it("closes each tenant's idle chats inside that tenant's frame", async () => {
    m.close.mockImplementation(async (tenantId: string) => { expect(m.current).toBe(tenantId); return { closed: tenantId === "t1" ? 2 : 0 } })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(m.frames).toEqual(["t1", "t2"])
    expect(m.close).toHaveBeenCalledWith("t1", expect.any(Date))
    expect(await res.json()).toMatchObject({ ok: true, perTenant: [{ tenantId: "t1", closed: 2 }, { tenantId: "t2", closed: 0 }] })
  })

  it("returns a NON-2XX when a tenant fails, after trying the rest", async () => {
    // The scheduler treats only a non-2xx as a failure.
    m.close.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce({ closed: 1 })
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(m.close).toHaveBeenCalledTimes(2)
    expect(await res.json()).toMatchObject({ ok: false, perTenant: [{ tenantId: "t1", error: "connection reset" }, { tenantId: "t2", closed: 1 }] })
  })
})
