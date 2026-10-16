import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ findMany: vi.fn(), snapshot: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findMany: h.findMany } } }))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: (_t: string, fn: () => unknown) => fn() }))
vi.mock("@/lib/reports/arrears-snapshot", () => ({ snapshotTenantArrears: h.snapshot }))

import { GET } from "./route"

const req = (secret?: string) => new NextRequest("http://localhost/api/cron/arrears-snapshot", {
  headers: secret ? { "x-cron-secret": secret } : {},
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("CRON_SECRET", "s".repeat(32))
  h.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }])
  h.snapshot.mockResolvedValue({ snapshotDate: "2026-10-16", loans: 3, written: 3 })
})

describe("GET /api/cron/arrears-snapshot", () => {
  it("refuses without the cron secret", async () => {
    expect((await GET(req())).status).toBe(401)
    expect(h.snapshot).not.toHaveBeenCalled()
  })

  it("snapshots every tenant", async () => {
    const res = await GET(req("s".repeat(32)))
    expect(res.status).toBe(200)
    expect(h.snapshot.mock.calls.map((c) => c[0])).toEqual(["t1", "t2"])
  })

  it("answers 503 when a tenant fails, after trying the rest", async () => {
    h.snapshot.mockRejectedValueOnce(new Error("boom"))
    const res = await GET(req("s".repeat(32)))
    expect(res.status).toBe(503)
    expect(h.snapshot).toHaveBeenCalledTimes(2)
  })
})
