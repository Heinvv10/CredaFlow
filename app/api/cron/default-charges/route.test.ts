/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const verifyCronSecretMock = vi.fn()
const configFindManyMock = vi.fn()
const sweepMock = vi.fn()

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: (...a: any[]) => verifyCronSecretMock(...a) }))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: (_t: string, fn: () => Promise<unknown>) => fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findMany: (...a: any[]) => configFindManyMock(...a) } },
}))
vi.mock("@/lib/loan/charges-sweep", () => ({
  sweepTenantCharges: (...a: any[]) => sweepMock(...a),
}))

import { GET } from "./route"

const req = () => new NextRequest("http://localhost/api/cron/default-charges")

beforeEach(() => {
  vi.clearAllMocks()
  verifyCronSecretMock.mockReturnValue(null)
})

describe("GET /api/cron/default-charges", () => {
  it("sweeps only tenants with default charges switched on", async () => {
    configFindManyMock.mockResolvedValue([{ tenantId: "t1" }])
    sweepMock.mockResolvedValue({ loans: 3, changed: 2, failures: [] })
    const res = await GET(req())
    expect(configFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { defaultChargesEnabled: true, defaultChargesStartedAt: { not: null } },
    }))
    expect(sweepMock).toHaveBeenCalledWith(expect.anything(), "t1", expect.any(Date), { source: "cron:default-charges" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, perTenant: [{ tenantId: "t1", loans: 3, changed: 2, failures: [] }] })
  })

  it("returns a NON-2XX when any loan failed, naming it, after sweeping the rest", async () => {
    // The deploy host's cron wrapper is `curl -fsS`: a 200 with ok:false is a green unit.
    configFindManyMock.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }])
    sweepMock
      .mockResolvedValueOnce({ loans: 2, changed: 1, failures: [{ loanId: "loan-9", error: "replay left 5 cents unallocated" }] })
      .mockResolvedValueOnce({ loans: 1, changed: 1, failures: [] })
    const res = await GET(req())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(sweepMock).toHaveBeenCalledTimes(2)
    expect(body.perTenant[0].failures).toEqual([{ loanId: "loan-9", error: "replay left 5 cents unallocated" }])
  })

  it("reports a tenant whose sweep could not start as a failure, and still sweeps the others", async () => {
    configFindManyMock.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }])
    sweepMock.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce({ loans: 1, changed: 0, failures: [] })
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect((await res.json()).perTenant).toEqual([
      { tenantId: "t1", error: "connection reset" },
      { tenantId: "t2", loans: 1, changed: 0, failures: [] },
    ])
  })

  it("is vacuously ok with no tenant switched on", async () => {
    configFindManyMock.mockResolvedValue([])
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(sweepMock).not.toHaveBeenCalled()
  })

  it("refuses an unauthenticated call", async () => {
    verifyCronSecretMock.mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await GET(req())).status).toBe(401)
    expect(configFindManyMock).not.toHaveBeenCalled()
  })
})
