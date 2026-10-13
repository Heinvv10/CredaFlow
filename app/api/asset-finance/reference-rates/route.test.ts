import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  logAuditStrict: vi.fn(),
  auditRefusal: vi.fn(),
  requireAssetFinanceEnabled: vi.fn(),
  tenant: { id: "t1" },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/asset-finance/require-enabled", () => ({ requireAssetFinanceEnabled: m.requireAssetFinanceEnabled }))
// Only the session guard is mocked: canDo is the real permission map.
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, handler: (tenant: { id: string }) => unknown) => handler(m.tenant),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    referenceRate: { findMany: m.findMany },
    $transaction: (fn: (tx: unknown) => unknown) => fn({ referenceRate: { create: m.create } }),
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))

import { GET, POST } from "./route"

const URL = "http://localhost/api/asset-finance/reference-rates"
const post = (body: unknown) => POST(new NextRequest(URL, { method: "POST", body: JSON.stringify(body) }))
const get = (query = "") => GET(new NextRequest(`${URL}${query}`))
const VALID = { basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.12" }
const signIn = (role: string) => m.requireApiRole.mockResolvedValue({ user: { id: "u1", email: "u1@test.invalid", role } })
const row = (i: number) => ({
  id: `rr${i}`, tenantId: "t1", basis: "PRIME", effectiveDate: new Date("2027-01-15T00:00:00Z"), rate: new Prisma.Decimal("0.12"),
  status: "PENDING", requestedById: "u1", decidedById: null, decidedAt: null, createdAt: new Date("2027-01-10T08:00:00Z"),
})

beforeEach(() => {
  signIn("LOAN_ADMIN")
  m.tenant.id = "t1"
  m.logAuditStrict.mockReset()
  m.auditRefusal.mockReset()
  m.requireAssetFinanceEnabled.mockReset().mockResolvedValue(null)
  m.findMany.mockReset().mockResolvedValue([row(1)])
  m.create.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...row(1), ...data, status: "PENDING", decidedById: null, decidedAt: null,
  }))
})

describe("POST /api/asset-finance/reference-rates", () => {
  it("answers 404 and writes nothing when the tenant has not enabled asset finance", async () => {
    m.requireAssetFinanceEnabled.mockResolvedValue(NextResponse.json({ error: "Not found" }, { status: 404 }))
    expect((await post(VALID)).status).toBe(404)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("passes through the role guard's refusal", async () => {
    m.requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await post(VALID)).status).toBe(403)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("refuses a CREDIT_OFFICER (passes the role guard, lacks decide_asset_finance) with an audited 403", async () => {
    signIn("CREDIT_OFFICER")
    expect((await post(VALID)).status).toBe(403)
    expect(m.create).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "REFERENCE_RATE_REFUSED", entity: "ReferenceRate", tenantId: "t1", userId: "u1", reason: "insufficient_role", status: 403,
    }))
  })

  it("answers 400 with the fields at fault and writes nothing; a rate outside the sanity band is refused", async () => {
    for (const rate of ["12", "0", "0.5", "0.75"]) {
      const response = await post({ ...VALID, rate })
      expect(response.status).toBe(400)
      expect((await response.json()).fields).toHaveProperty("rate")
    }
    expect(m.create).not.toHaveBeenCalled()
  })

  it("records the rate PENDING, requested by the caller, with its audit row in one transaction", async () => {
    const response = await post(VALID)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "rr1", basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.12", status: "PENDING", requestedById: "u1" })
    expect(m.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", requestedById: "u1" })
    expect(m.create.mock.calls[0][0].data).not.toHaveProperty("status")
    expect(m.logAuditStrict).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", userId: "u1", action: "REFERENCE_RATE_RECORDED", entityId: "rr1", newValue: { basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.12", status: "PENDING" } }),
      expect.anything(),
    )
  })

  it("answers 409 to a second live value for the same basis and date", async () => {
    m.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5.22.0" }))
    expect((await post(VALID)).status).toBe(409)
  })
})

describe("GET /api/asset-finance/reference-rates", () => {
  it("answers 404 and reads nothing when the tenant has not enabled asset finance", async () => {
    m.requireAssetFinanceEnabled.mockResolvedValue(NextResponse.json({ error: "Not found" }, { status: 404 }))
    expect((await get()).status).toBe(404)
    expect(m.findMany).not.toHaveBeenCalled()
  })

  it("passes through the role guard's refusal", async () => {
    m.requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    expect(m.findMany).not.toHaveBeenCalled()
  })

  it("reads only the request's tenant, at most 200 rows a page", async () => {
    m.tenant.id = "t2"
    const response = await get()
    expect(response.status).toBe(200)
    expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t2" }, skip: 0, take: 201 }))
    expect(m.requireAssetFinanceEnabled).toHaveBeenCalledWith("t2")
    expect(await response.json()).toMatchObject({ rates: [{ id: "rr1", status: "PENDING", effectiveDate: "2027-01-15" }], nextOffset: null })
  })

  it("pages: nextOffset when there is more, and refuses a limit above 200", async () => {
    m.findMany.mockResolvedValue([row(1), row(2), row(3)])
    const response = await get("?limit=2&offset=4")
    expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 4, take: 3 }))
    const body = await response.json()
    expect(body.rates.map((r: { id: string }) => r.id)).toEqual(["rr1", "rr2"])
    expect(body.nextOffset).toBe(6)
    expect((await get("?limit=201")).status).toBe(400)
    expect((await get("?offset=-1")).status).toBe(400)
  })
})
