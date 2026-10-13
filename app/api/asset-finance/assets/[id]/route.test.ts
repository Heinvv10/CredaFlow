import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const m = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    financedAsset: { findFirst: vi.fn(), update: vi.fn() },
  }
  return {
    tx,
    flag: { on: true },
    findFirst: vi.fn(),
    requireApiRole: vi.fn(),
    logAuditStrict: vi.fn(),
    auditRefusal: vi.fn(),
  }
})

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    financedAsset: { findFirst: m.findFirst },
    $transaction: (fn: (tx: unknown) => unknown) => fn(m.tx),
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
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))

import { GET, PATCH } from "./route"

const signIn = (id: string, role: string) =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })
const params = { params: Promise.resolve({ id: "asset-1" }) }
const patch = (body: unknown) => PATCH(new NextRequest("http://localhost/api/asset-finance/assets/asset-1", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), params)

const stored = (over: Record<string, unknown> = {}) => ({
  id: "asset-1", tenantId: "tenant-1", serialNumber: "TEST0000000000001", vin: null, insurer: null, lenderNotedConfirmed: false,
  cashPriceExclVatCents: 100_000_000, vatCents: 15_000_000, residualCents: null, releasedAt: null,
  _count: { loans: 0 }, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("officer-a", "CREDIT_OFFICER")
  m.tx.$queryRaw.mockResolvedValue([{ id: "asset-1" }])
  m.tx.financedAsset.findFirst.mockResolvedValue(stored())
  m.tx.financedAsset.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...stored(), ...data }))
})

describe("/api/asset-finance/assets/[id]", () => {
  it("answers 404 when the flag is off, and for an asset outside the tenant", async () => {
    m.flag.on = false
    expect((await GET(new NextRequest("http://localhost/api/asset-finance/assets/asset-1"), params)).status).toBe(404)
    expect((await patch({ insurer: "TEST Insurer" })).status).toBe(404)
    m.flag.on = true
    m.findFirst.mockResolvedValue(null)
    expect((await GET(new NextRequest("http://localhost/api/asset-finance/assets/asset-1"), params)).status).toBe(404)
    expect(m.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "asset-1", tenantId: "tenant-1" } }))
  })

  it("refuses an edit without manage_asset_finance 403", async () => {
    signIn("viewer", "READONLY")
    expect((await patch({ insurer: "TEST Insurer" })).status).toBe(403)
    expect(m.tx.financedAsset.update).not.toHaveBeenCalled()
  })

  it("updates the given fields and audits old and new values", async () => {
    const res = await patch({ insurer: "TEST Insurer", lenderNotedConfirmed: true })
    expect(res.status).toBe(200)
    expect(m.tx.financedAsset.update).toHaveBeenCalledWith({ where: { id: "asset-1" }, data: { insurer: "TEST Insurer", lenderNotedConfirmed: true } })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "ASSET_UPDATED", oldValue: { insurer: null, lenderNotedConfirmed: false }, newValue: { insurer: "TEST Insurer", lenderNotedConfirmed: true },
    }), m.tx)
  })

  it("freezes the contract fields once the asset is on a booked loan, but not the insurance", async () => {
    m.tx.financedAsset.findFirst.mockResolvedValue(stored({ _count: { loans: 1 } }))
    const res = await patch({ serialNumber: "TEST0000000000002" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/booked loan; serialNumber/)
    expect(m.tx.financedAsset.update).not.toHaveBeenCalled()
    expect((await patch({ insurer: "TEST Insurer" })).status).toBe(200)
  })

  it("does not edit a released asset", async () => {
    m.tx.financedAsset.findFirst.mockResolvedValue(stored({ releasedAt: new Date() }))
    expect((await patch({ insurer: "TEST Insurer" })).status).toBe(409)
    expect(m.tx.financedAsset.update).not.toHaveBeenCalled()
  })

  it("checks the residual against the stored price when only the residual changes", async () => {
    const res = await patch({ residualCents: 115_000_001 })
    expect(res.status).toBe(400)
    expect(m.tx.financedAsset.update).not.toHaveBeenCalled()
  })

  it("maps a duplicate serial on edit to 409 and audits it", async () => {
    m.tx.financedAsset.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002", clientVersion: "test", meta: { target: ["tenantId", "upper(btrim(serialNumber))"] },
    }))
    const res = await patch({ serialNumber: "TEST0000000000002" })
    expect(res.status).toBe(409)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ action: "ASSET_DUPLICATE_REFUSED", entityId: "asset-1" }))
  })
})
