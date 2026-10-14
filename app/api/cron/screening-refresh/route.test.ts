import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const configFindManyMock = vi.fn()
const refreshMock = vi.fn()

vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: (_t: string, fn: () => Promise<unknown>) => fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findMany: (...a: unknown[]) => configFindManyMock(...a) } },
}))
vi.mock("@/lib/screening/refresh", () => ({
  refreshTenantScreening: (...a: unknown[]) => refreshMock(...a),
}))

import { GET } from "./route"

const req = (secret?: string) => new NextRequest("http://localhost/api/cron/screening-refresh", {
  headers: secret ? { "x-cron-secret": secret } : {},
})
const ok = { candidates: 2, screened: 2, flagged: 1, failed: 0, remaining: 0, errors: [] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("CRON_SECRET", "test-cron-secret")
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("GET /api/cron/screening-refresh", () => {
  it("refuses a request without the cron secret and screens nobody", async () => {
    for (const secret of [undefined, "wrong-secret-value"]) {
      const res = await GET(req(secret))
      expect(res.status).toBe(401)
    }
    expect(configFindManyMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("re-screens only tenants with a screening provider configured", async () => {
    configFindManyMock.mockResolvedValue([{ tenantId: "t1" }])
    refreshMock.mockResolvedValue(ok)
    const res = await GET(req("test-cron-secret"))
    expect(configFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: { screeningProvider: { not: null } } }))
    expect(refreshMock).toHaveBeenCalledWith("t1", expect.any(Date), expect.any(Number))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, perTenant: [{ tenantId: "t1", ...ok }] })
  })

  it("A5: reports a backlog the time budget left (remaining) without calling it a failure, and shares one deadline", async () => {
    configFindManyMock.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }])
    refreshMock.mockResolvedValue({ ...ok, candidates: 900, screened: 300, remaining: 600 })
    const res = await GET(req("test-cron-secret"))
    expect(res.status).toBe(200)
    expect((await res.json()).perTenant[0]).toMatchObject({ candidates: 900, remaining: 600 })
    const deadlines = refreshMock.mock.calls.map((c) => c[2])
    expect(new Set(deadlines).size).toBe(1)
  })

  it("returns 503 when a provider call failed or a tenant threw, after doing the rest", async () => {
    configFindManyMock.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }, { tenantId: "t3" }])
    refreshMock
      .mockResolvedValueOnce({ ...ok, failed: 1 })
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(ok)
    const res = await GET(req("test-cron-secret"))
    expect(res.status).toBe(503)
    expect(refreshMock).toHaveBeenCalledTimes(3)
    const body = await res.json()
    expect(body.perTenant[1]).toEqual({ tenantId: "t2", error: "db down" })
  })
})
