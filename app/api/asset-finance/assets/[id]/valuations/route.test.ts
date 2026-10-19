import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  flag: { on: true },
  findAsset: vi.fn(),
  findDocument: vi.fn(),
  findDeals: vi.fn(),
  create: vi.fn(),
  requireApiRole: vi.fn(),
  logAuditStrict: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    financedAsset: { findFirst: m.findAsset },
    entityDocument: { findFirst: m.findDocument },
    assetFinanceDeal: { findMany: m.findDeals },
    $transaction: (fn: (tx: unknown) => unknown) => fn({ assetValuation: { create: m.create } }),
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

const signIn = (id: string, role: string) =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/asset-finance/assets/asset-1/valuations", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "asset-1" }) })
const valuation = { valuedOn: "2026-10-01", source: "ASSESSOR", valuerName: "TEST Assessor", amountCents: 120_000_000 }

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("officer-a", "CREDIT_OFFICER")
  m.findAsset.mockResolvedValue({ id: "asset-1" })
  m.findDocument.mockResolvedValue({ id: "doc-1" })
  m.findDeals.mockResolvedValue([])
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "val-1", ...data }))
})

describe("POST /api/asset-finance/assets/[id]/valuations", () => {
  it("answers 404 when the flag is off", async () => {
    m.flag.on = false
    expect((await post(valuation)).status).toBe(404)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("refuses a user without manage_asset_finance 403", async () => {
    signIn("viewer", "READONLY")
    expect((await post(valuation)).status).toBe(403)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("refuses a valuation dated in the future 400", async () => {
    const res = await post({ ...valuation, valuedOn: "2999-01-01" })
    expect(res.status).toBe(400)
    expect((await res.json()).fields.valuedOn).toMatch(/future/)
  })

  it("answers 404 for an asset outside the tenant", async () => {
    m.findAsset.mockResolvedValue(null)
    expect((await post(valuation)).status).toBe(404)
    expect(m.findAsset).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "asset-1", tenantId: "tenant-1" } }))
  })

  it("refuses a document id that is not a live document of the tenant", async () => {
    m.findDocument.mockResolvedValue(null)
    const res = await post({ ...valuation, documentId: "doc-x" })
    expect(res.status).toBe(400)
    expect(m.findDocument).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "doc-x", tenantId: "tenant-1", deletedAt: null, docType: "VALUATION" },
    }))
    expect(m.create).not.toHaveBeenCalled()
  })

  it("with no deal on the asset, accepts only a VALUATION document of the tenant", async () => {
    expect((await post({ ...valuation, documentId: "doc-1" })).status).toBe(201)
    expect(m.findDeals).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1", assetId: "asset-1" } }))
    const where = m.findDocument.mock.calls[0][0].where
    expect(where).toEqual({ id: "doc-1", tenantId: "tenant-1", deletedAt: null, docType: "VALUATION" })
  })

  it("once deals reference the asset, requires the document to belong to one of their entities", async () => {
    m.findDeals.mockResolvedValue([{ entityId: "ent-a", clientId: null }, { entityId: "ent-b", clientId: null }, { entityId: "ent-a", clientId: null }])
    expect((await post({ ...valuation, documentId: "doc-1" })).status).toBe(201)
    expect(m.findDocument.mock.calls[0][0].where).toEqual({
      id: "doc-1", tenantId: "tenant-1", deletedAt: null, docType: "VALUATION", OR: [{ entityId: "ent-a" }, { entityId: "ent-b" }],
    })
  })

  it("scopes an individual lessee's deal to that client, never to documents without an entity", async () => {
    m.findDeals.mockResolvedValue([{ entityId: null, clientId: "client-a" }])
    expect((await post({ ...valuation, documentId: "doc-1" })).status).toBe(201)
    expect(m.findDocument.mock.calls[0][0].where).toEqual({
      id: "doc-1", tenantId: "tenant-1", deletedAt: null, docType: "VALUATION", OR: [{ clientId: "client-a", entityId: null }],
    })
  })

  it("refuses another borrower's document (or a non-valuation one) 400, recording nothing", async () => {
    m.findDeals.mockResolvedValue([{ entityId: "ent-a", clientId: null }])
    m.findDocument.mockResolvedValue(null)
    const res = await post({ ...valuation, documentId: "doc-other" })
    expect(res.status).toBe(400)
    expect((await res.json()).fields.documentId).toMatch(/borrower on this asset's deal/)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("records the valuation on the asset and audits it", async () => {
    const res = await post({ ...valuation, documentId: "doc-1" })
    expect(res.status).toBe(201)
    expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: "tenant-1", assetId: "asset-1", source: "ASSESSOR", amountCents: 120_000_000, documentId: "doc-1",
      valuedOn: new Date("2026-10-01T00:00:00.000Z"), createdById: "officer-a",
    }) })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "ASSET_VALUATION_RECORDED", entityId: "val-1" }), expect.anything())
  })
})
