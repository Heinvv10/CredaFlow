/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const verifyCronSecretMock = vi.fn()
const tenantFindManyMock = vi.fn()
const configFindUniqueMock = vi.fn()
const sweepMock = vi.fn()

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: (...a: any[]) => verifyCronSecretMock(...a) }))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: (_t: string, fn: () => Promise<unknown>) => fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findMany: (...a: any[]) => tenantFindManyMock(...a) },
    tenantConfig: { findUnique: (...a: any[]) => configFindUniqueMock(...a) },
  },
}))
vi.mock("@/lib/loan/charges-sweep", () => ({
  sweepTenantCharges: (...a: any[]) => sweepMock(...a),
}))

import { GET } from "./route"

const req = () => new NextRequest("http://localhost/api/cron/default-charges")
const ON = { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-01-01T00:00:00+02:00") }
const tenant = (id: string) => ({ id, name: id })

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  verifyCronSecretMock.mockReturnValue(null)
})

describe("GET /api/cron/default-charges", () => {
  it("reads every ACTIVE tenant but sweeps only those with default charges switched on and a go-live recorded", async () => {
    tenantFindManyMock.mockResolvedValue([tenant("t1"), tenant("t_off"), tenant("t_nogolive")])
    configFindUniqueMock.mockImplementation(async ({ where }: any) => ({
      t1: ON,
      t_off: { defaultChargesEnabled: false, defaultChargesStartedAt: ON.defaultChargesStartedAt },
      t_nogolive: { defaultChargesEnabled: true, defaultChargesStartedAt: null },
    })[where.tenantId as string])
    sweepMock.mockResolvedValue({ loans: 3, changed: 2, failures: [] })
    const res = await GET(req())
    expect(tenantFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE" } }))
    expect(sweepMock).toHaveBeenCalledTimes(1)
    expect(sweepMock).toHaveBeenCalledWith(expect.anything(), "t1", expect.any(Date), { source: "cron:default-charges" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, perTenant: [{ tenantId: "t1", loans: 3, changed: 2, failures: [] }] })
  })

  it("sweeps a tenant that is not the deployment's default", async () => {
    tenantFindManyMock.mockResolvedValue([tenant("t_default"), tenant("t_second")])
    configFindUniqueMock.mockResolvedValue(ON)
    sweepMock.mockResolvedValue({ loans: 1, changed: 1, failures: [] })
    await GET(req())
    expect(sweepMock.mock.calls.map((c) => c[1])).toEqual(["t_default", "t_second"])
  })

  it("returns a NON-2XX when any loan failed, naming it but not the cause, after sweeping the rest", async () => {
    // The deploy host's cron wrapper is `curl -fsS`: a 200 with ok:false is a green unit.
    tenantFindManyMock.mockResolvedValue([tenant("t1"), tenant("t2")])
    configFindUniqueMock.mockResolvedValue(ON)
    sweepMock
      .mockResolvedValueOnce({ loans: 2, changed: 1, failures: [{ loanId: "loan-9", error: "replay left 5 cents unallocated" }] })
      .mockResolvedValueOnce({ loans: 1, changed: 1, failures: [] })
    const res = await GET(req())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(sweepMock).toHaveBeenCalledTimes(2)
    expect(body.perTenant[0].failures).toEqual([{ loanId: "loan-9" }])
    expect(JSON.stringify(body)).not.toContain("cents unallocated")
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("replay left 5 cents unallocated"))
  })

  it("reports a tenant whose sweep could not start without the cause, 200 partial while another tenant swept", async () => {
    tenantFindManyMock.mockResolvedValue([tenant("t1"), tenant("t2")])
    configFindUniqueMock.mockResolvedValue(ON)
    sweepMock.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce({ loans: 1, changed: 0, failures: [] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, partial: true })
    expect(body.perTenant).toEqual([
      { tenantId: "t1", error: "failed; see the server log" },
      { tenantId: "t2", loans: 1, changed: 0, failures: [] },
    ])
  })

  it("is 503 when every swept tenant failed", async () => {
    tenantFindManyMock.mockResolvedValue([tenant("t1")])
    configFindUniqueMock.mockResolvedValue(ON)
    sweepMock.mockRejectedValue(new Error("connection reset"))
    expect((await GET(req())).status).toBe(503)
  })

  it("is vacuously ok with no tenant switched on", async () => {
    tenantFindManyMock.mockResolvedValue([tenant("t1")])
    configFindUniqueMock.mockResolvedValue({ defaultChargesEnabled: false, defaultChargesStartedAt: null })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(sweepMock).not.toHaveBeenCalled()
  })

  it("refuses an unauthenticated call", async () => {
    verifyCronSecretMock.mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await GET(req())).status).toBe(401)
    expect(tenantFindManyMock).not.toHaveBeenCalled()
  })
})
