import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    loanApplication: { findFirst: vi.fn(), update: vi.fn() },
    ncaRegimeOverride: { findFirst: vi.fn(), create: vi.fn() },
  }
  return { tx, flag: { on: true }, transaction: vi.fn(), requireApiRole: vi.fn(), logAuditStrict: vi.fn() }
})

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    $transaction: (fn: (tx: unknown) => unknown) => {
      m.transaction()
      return fn(m.tx)
    },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "tenant-1", name: "T" }),
}))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))

import { POST } from "./route"

const REASON = "Audited AFS show R4m turnover"
const request = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/asset-finance/applications/app-1/nca-overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "app-1" }) },
  )

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  m.requireApiRole.mockResolvedValue({ user: { id: "admin-a", email: "a@lender.test", role: "LOAN_ADMIN", tenantId: "tenant-1" } })
  m.tx.$queryRaw.mockResolvedValue([{ id: "app-1" }])
  m.tx.loanApplication.findFirst.mockResolvedValue({ id: "app-1", entityId: "ent-1", status: "SUBMITTED", ncaRegime: "NCA" })
  m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(null)
  m.tx.ncaRegimeOverride.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "ov-1", status: "PENDING", decidedById: null, decidedAt: null, ...data,
  }))
})

describe("POST /api/asset-finance/applications/[id]/nca-overrides", () => {
  it("answers 404 when the tenant has not enabled asset finance", async () => {
    m.flag.on = false
    expect((await request({ toRegime: "NON_NCA", reason: REASON })).status).toBe(404)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("passes a refused role guard through", async () => {
    const { NextResponse } = await import("next/server")
    m.requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await request({ toRegime: "NON_NCA", reason: REASON })).status).toBe(403)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it.each([
    [{ toRegime: "NON_NCA", reason: "too short" }, /reason/],
    [{ toRegime: "NON_NCA", reason: "   short    " }, /reason/],
    [{ toRegime: "NON_NCA" }, /reason/],
    [{ toRegime: "EXEMPT", reason: REASON }, /toRegime/],
    [[], /JSON object/],
  ])("answers 400 for %j", async (body, message) => {
    const res = await request(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(message)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("answers 404 for an application outside the tenant", async () => {
    m.tx.$queryRaw.mockResolvedValue([])
    expect((await request({ toRegime: "NON_NCA", reason: REASON })).status).toBe(404)
    expect(m.tx.ncaRegimeOverride.create).not.toHaveBeenCalled()
  })

  it("refuses a natural-person application 422", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue({ id: "app-1", entityId: null, status: "SUBMITTED", ncaRegime: null })
    expect((await request({ toRegime: "NON_NCA", reason: REASON })).status).toBe(422)
  })

  it.each([
    ["unclassified", { ncaRegime: null }, /Classify/],
    ["decided", { status: "APPROVED" }, /frozen/],
    ["already at the target", { ncaRegime: "NON_NCA" }, /already NON_NCA/],
  ])("answers 409 when the application is %s", async (_label, over, message) => {
    m.tx.loanApplication.findFirst.mockResolvedValue({ id: "app-1", entityId: "ent-1", status: "SUBMITTED", ncaRegime: "NCA", ...over })
    const res = await request({ toRegime: "NON_NCA", reason: REASON })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(message)
    expect(m.tx.ncaRegimeOverride.create).not.toHaveBeenCalled()
  })

  it("answers 409 while another override is pending", async () => {
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue({ id: "ov-0" })
    const res = await request({ toRegime: "NON_NCA", reason: REASON })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ overrideId: "ov-0" })
    expect(m.tx.ncaRegimeOverride.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", applicationId: "app-1", status: "PENDING" },
    }))
    expect(m.tx.ncaRegimeOverride.create).not.toHaveBeenCalled()
  })

  it("NCA → NON_NCA: records a PENDING request and leaves the regime alone", async () => {
    const res = await request({ toRegime: "NON_NCA", reason: `  ${REASON}  ` })
    expect(res.status).toBe(201)
    expect(m.tx.ncaRegimeOverride.create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-1", applicationId: "app-1", fromRegime: "NCA", toRegime: "NON_NCA", reason: REASON, requestedById: "admin-a" },
    })
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(m.logAuditStrict).toHaveBeenCalledTimes(1)
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_OVERRIDE_REQUESTED", entity: "NcaRegimeOverride", entityId: "ov-1", userId: "admin-a",
      newValue: expect.objectContaining({ fromRegime: "NCA", toRegime: "NON_NCA", status: "PENDING", reason: REASON }),
    }), m.tx)
  })

  it("NON_NCA → NCA: applies at once, decided by the requester, with both audit rows", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue({ id: "app-1", entityId: "ent-1", status: "UNDER_REVIEW", ncaRegime: "NON_NCA" })
    const res = await request({ toRegime: "NCA", reason: "Turnover was the group's, not the entity's" })
    expect(res.status).toBe(201)
    expect(m.tx.ncaRegimeOverride.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromRegime: "NON_NCA", toRegime: "NCA", status: "APPROVED", requestedById: "admin-a", decidedById: "admin-a", decidedAt: expect.any(Date),
      }),
    })
    expect(m.tx.loanApplication.update).toHaveBeenCalledWith({ where: { id: "app-1", tenantId: "tenant-1" }, data: { ncaRegime: "NCA" } })
    expect(m.logAuditStrict.mock.calls.map(([params]) => params.action)).toEqual(["NCA_OVERRIDE_REQUESTED", "NCA_OVERRIDE_DECIDED"])
    for (const call of m.logAuditStrict.mock.calls) expect(call[1]).toBe(m.tx)
  })
})
