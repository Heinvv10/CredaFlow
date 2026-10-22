import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The routes added by docs/asset-finance/SLICE5-FOLLOWUPS.md part T, their own
// contract: the permission each needs (READONLY and INSURANCE_OFFICER never
// see a trail, record a theft report or read a closure letter), the lib's
// answer passed as is, the letter's view on the access register before its
// bytes, the cron's secret and its 503 on a failure, and the void routes'
// permission and body. What the libs do is proven on real Postgres
// (lib/telematics/theft-trail, lib/asset-finance/meter-void and
// tracker-closure integration suites).
const m = vi.hoisted(() => ({
  flag: { on: true },
  requireApiRole: vi.fn(),
  order: [] as string[],
  closure: null as null | { letterStoragePath: string | null; loan: { reference: string } },
  lib: { revealPositionTrail: vi.fn(), recordTheftReport: vi.fn(), processTrackerClosures: vi.fn(), requestMeterReadingVoid: vi.fn(), decideMeterReadingVoid: vi.fn() },
  leaseOpts: [] as unknown[],
  cronDenied: null as Response | null,
  pending: [] as { tenantId: string }[],
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    trackerClosure: { findFirst: async () => m.closure },
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }), findMany: async () => m.pending },
    documentAccessLog: { create: vi.fn(async () => { m.order.push("access-logged") }) },
  },
}))
vi.mock("@/lib/storage", () => ({ readFile: vi.fn(async () => { m.order.push("bytes-read"); return Buffer.from("%PDF-1.7 synthetic") }) }))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "tenant-1", name: "T" }),
}))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: (t: string, fn: () => unknown) => { m.order.push(`tenant:${t}`); return fn() } }))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth-guards")>()), requireApiRole: () => m.requireApiRole() }))
vi.mock("@/lib/telematics/position-trail", () => ({ revealPositionTrail: m.lib.revealPositionTrail }))
vi.mock("@/lib/telematics/theft-reports", () => ({ recordTheftReport: m.lib.recordTheftReport }))
vi.mock("@/lib/asset-finance/tracker-closure", () => ({ processTrackerClosures: m.lib.processTrackerClosures }))
vi.mock("@/lib/asset-finance/meter-void", () => ({ requestMeterReadingVoid: m.lib.requestMeterReadingVoid, decideMeterReadingVoid: m.lib.decideMeterReadingVoid }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: () => m.cronDenied }))
vi.mock("@/lib/asset-finance/lease-route", () => ({
  leaseStaffAction: async (_req: Request, opts: unknown, action: (tx: unknown, actor: unknown, today: string, body: Record<string, unknown>) => Promise<unknown>) => {
    m.leaseOpts.push(opts)
    return Response.json(await action("tx", { tenantId: "tenant-1", userId: "u1" }, "2026-10-22", { reason: "Typed 9 000 for 1 090", decision: "APPROVE" }))
  },
}))

import { POST as trail } from "@/app/api/asset-finance/loans/[loanId]/telematics/trail/route"
import { POST as theft } from "@/app/api/asset-finance/loans/[loanId]/telematics/theft-reports/route"
import { GET as letter } from "@/app/api/asset-finance/loans/[loanId]/telematics/closures/[closureId]/letter/route"
import { GET as cron } from "@/app/api/cron/asset-finance-telematics-closure/route"
import { POST as requestVoid } from "@/app/api/asset-finance/leases/[loanId]/readings/[readingId]/void/route"
import { POST as decideVoid } from "@/app/api/asset-finance/leases/[loanId]/reading-voids/[voidId]/decide/route"

const signIn = (role: string) => m.requireApiRole.mockResolvedValue({ user: { id: "u1", email: "u1@lender.test", role, tenantId: "tenant-1" } })
const req = (body?: unknown) =>
  new NextRequest("http://localhost/x", body === undefined ? { headers: { "user-agent": "route-test" } } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const loan = { params: Promise.resolve({ loanId: "loan-1" }) }
const calls = {
  trail: () => trail(req({ context: "THEFT" }), loan),
  theft: () => theft(req({ sapsCaseNumber: "CAS 12/10/2026", reportedOn: "2026-10-20" }), loan),
  letter: () => letter(req(), { params: Promise.resolve({ loanId: "loan-1", closureId: "trc_1" }) }),
}

beforeEach(() => {
  m.flag.on = true
  m.order.length = 0
  m.leaseOpts.length = 0
  m.closure = { letterStoragePath: "/synthetic/letter.pdf", loan: { reference: "AF-0001" } }
  m.cronDenied = null
  m.pending = []
  for (const fn of Object.values(m.lib)) fn.mockReset()
})

describe("part T staff telematics routes", () => {
  it("404 while the asset-finance flag is off", async () => {
    signIn("SUPER_ADMIN")
    m.flag.on = false
    for (const call of Object.values(calls)) expect((await call()).status).toBe(404)
  })

  it.each(["READONLY", "INSURANCE_OFFICER"])("refuse %s the trail, a theft report and a closure letter (403), reaching no lib code or file", async (role) => {
    signIn(role)
    for (const call of Object.values(calls)) expect((await call()).status).toBe(403)
    for (const fn of Object.values(m.lib)) expect(fn).not.toHaveBeenCalled()
    expect(m.order).toEqual([])
  })

  it("pass a collections officer's trail and theft report to the lib with the request's facts, and its answer back", async () => {
    signIn("COLLECTIONS_OFFICER")
    m.lib.revealPositionTrail.mockResolvedValue({ kind: "ok", points: [], truncated: false })
    expect(await (await calls.trail()).json()).toEqual({ ok: true, points: [], truncated: false })
    expect(m.lib.revealPositionTrail).toHaveBeenCalledWith(expect.objectContaining({ role: "COLLECTIONS_OFFICER", tenantId: "tenant-1" }), "loan-1", { context: "THEFT" },
      expect.objectContaining({ userAgent: null }))
    m.lib.recordTheftReport.mockResolvedValue({ kind: "ok", reportId: "tr_1", validUntil: "2026-11-21" })
    const created = await calls.theft()
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ ok: true, reportId: "tr_1", validUntil: "2026-11-21" })
    m.lib.recordTheftReport.mockResolvedValue({ kind: "refused", status: 400, error: "Invalid theft report", fields: { sapsCaseNumber: "A SAPS case number" } })
    const bad = await calls.theft()
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: "Invalid theft report", fields: { sapsCaseNumber: "A SAPS case number" } })
  })

  it("serve the letter as a PDF only after writing its view to the access register; 404 with no letter", async () => {
    signIn("COLLECTIONS_OFFICER")
    const served = await calls.letter()
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("application/pdf")
    expect(served.headers.get("cache-control")).toBe("no-store")
    expect(m.order).toEqual(["access-logged", "bytes-read"])
    m.closure = { letterStoragePath: null, loan: { reference: "AF-0001" } }
    m.order.length = 0
    expect((await calls.letter()).status).toBe(404)
    expect(m.order).toEqual([])
  })
})

describe("closure cron", () => {
  it("refuses without the cron secret, processing nothing", async () => {
    m.cronDenied = Response.json({ error: "Unauthorized" }, { status: 401 })
    expect((await cron(req())).status).toBe(401)
    expect(m.lib.processTrackerClosures).not.toHaveBeenCalled()
  })

  it("processes each asset-finance lender under its tenant, and answers 503 with the counts when any failed", async () => {
    m.pending = [{ tenantId: "t1" }, { tenantId: "t2" }]
    m.lib.processTrackerClosures.mockResolvedValueOnce({ closures: 2, failed: 0 }).mockRejectedValueOnce(new Error("synthetic"))
    const res = await cron(req())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, tenants: 2, closures: 2, failed: 1 })
    // Each asset-finance lender's closures are processed under its own tenant.
    expect(m.order).toEqual(["tenant:t1", "tenant:t2"])
    m.pending = [{ tenantId: "t1" }]
    m.lib.processTrackerClosures.mockResolvedValueOnce({ closures: 1, failed: 0 })
    expect(await (await cron(req())).json()).toEqual({ ok: true, tenants: 1, closures: 1, failed: 0 })
  })
})

describe("meter-reading void routes", () => {
  it("need manage_asset_finance and pass the reading, the reason and the decision through", async () => {
    m.lib.requestMeterReadingVoid.mockResolvedValue({ kind: "requested", voidId: "mv_1" })
    m.lib.decideMeterReadingVoid.mockResolvedValue({ kind: "decided", status: "APPROVED" })
    await requestVoid(req({}), { params: Promise.resolve({ loanId: "loan-1", readingId: "mr_1" }) })
    await decideVoid(req({}), { params: Promise.resolve({ loanId: "loan-1", voidId: "mv_1" }) })
    expect(m.leaseOpts).toEqual([
      { loanId: "loan-1", permission: "manage_asset_finance", action: "meter_reading_void" },
      { loanId: "loan-1", permission: "manage_asset_finance", action: "meter_reading_void_decision" },
    ])
    expect(m.lib.requestMeterReadingVoid).toHaveBeenCalledWith("tx", expect.objectContaining({ userId: "u1" }), { loanId: "loan-1", readingId: "mr_1", reason: "Typed 9 000 for 1 090" })
    expect(m.lib.decideMeterReadingVoid).toHaveBeenCalledWith("tx", expect.objectContaining({ userId: "u1" }), { loanId: "loan-1", voidId: "mv_1", decision: "APPROVE" })
  })
})
