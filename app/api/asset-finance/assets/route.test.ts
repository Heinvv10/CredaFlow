import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const m = vi.hoisted(() => ({
  flag: { on: true },
  create: vi.fn(),
  findMany: vi.fn(),
  requireApiRole: vi.fn(),
  logAuditStrict: vi.fn(),
  auditRefusal: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    financedAsset: { findMany: m.findMany },
    $transaction: (fn: (tx: unknown) => unknown) => fn({ financedAsset: { create: m.create } }),
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "tenant-1", name: "T" }),
}))
// Only the session guard is mocked: canDo is the real permission map.
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))

import { GET, POST } from "./route"

const signIn = (id: string, role: string) =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })

const asset = {
  assetClass: "EXCAVATOR", make: "TEST Make", model: "TX-200", year: 2024,
  serialNumber: "test0000000000001", vin: "vintest0000000001", cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000,
}
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/asset-finance/assets", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))
const uniqueViolation = (target: string[]) => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
  code: "P2002", clientVersion: "test", meta: { modelName: "FinancedAsset", target },
})

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("officer-a", "CREDIT_OFFICER")
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "asset-1", ...data }))
  m.findMany.mockResolvedValue([])
})

describe("/api/asset-finance/assets", () => {
  it("answers 404 to GET and POST when the tenant has not enabled asset finance", async () => {
    m.flag.on = false
    expect((await GET(new NextRequest("http://localhost/api/asset-finance/assets"))).status).toBe(404)
    expect((await post(asset)).status).toBe(404)
    expect(m.findMany).not.toHaveBeenCalled()
    expect(m.create).not.toHaveBeenCalled()
  })

  it("lists only the tenant's assets", async () => {
    await GET(new NextRequest("http://localhost/api/asset-finance/assets"))
    expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1" } }))
  })

  it("refuses a user without manage_asset_finance 403", async () => {
    signIn("viewer", "READONLY")
    const res = await post(asset)
    expect(res.status).toBe(403)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("answers 400 with the failing fields", async () => {
    const res = await post({ ...asset, year: 1900, vatCents: -1 })
    expect(res.status).toBe(400)
    expect((await res.json()).fields).toEqual({ year: expect.any(String), vatCents: expect.any(String) })
    expect(m.create).not.toHaveBeenCalled()
  })

  it("creates the asset in the tenant, normalised, and audits it in the same transaction", async () => {
    const res = await post(asset)
    expect(res.status).toBe(201)
    expect(m.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "tenant-1", createdById: "officer-a", serialNumber: "TEST0000000000001", vin: "VINTEST0000000001" }),
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ASSET_CREATED", entity: "FinancedAsset", entityId: "asset-1", userId: "officer-a" }),
      expect.anything(),
    )
  })

  it.each([
    [["tenantId", "upper(btrim(serialNumber))"], /serial number is already on the book/],
    [["tenantId", "upper(btrim(vin))"], /VIN is already on the book/],
  ])("maps the duplicate index %j to 409 and audits the refusal", async (target, message) => {
    m.create.mockRejectedValue(uniqueViolation(target))
    const res = await post(asset)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(message)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "ASSET_DUPLICATE_REFUSED", reason: "duplicate_unreleased_asset", status: 409, tenantId: "tenant-1",
    }))
  })

  it("rethrows a database error that is not the duplicate check", async () => {
    m.create.mockRejectedValue(uniqueViolation(["tenantId", "id"]))
    await expect(post(asset)).rejects.toThrow(/Unique constraint/)
    expect(m.auditRefusal).not.toHaveBeenCalled()
  })
})
