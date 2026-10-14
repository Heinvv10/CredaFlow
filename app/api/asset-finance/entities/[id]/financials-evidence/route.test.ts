import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The real-database proof that another entity's or an unverified document is
// refused is lib/asset-finance/portal-access.integration.test.ts; this pins
// the route's flow and the query it trusts.
const m = vi.hoisted(() => ({
  session: { role: "CREDIT_OFFICER" as string },
  flag: { on: true },
  tx: {
    $queryRaw: vi.fn(),
    businessEntity: { findFirst: vi.fn(), update: vi.fn() },
    entityDocument: { findMany: vi.fn() },
  },
  coreFindFirst: vi.fn(),
  logAuditStrict: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-1", email: "officer@lender.test", role: m.session.role, tenantId: "tenant-1" } })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    businessEntity: { findFirst: m.coreFindFirst },
    $transaction: (fn: (tx: unknown) => unknown) => fn(m.tx),
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))

import { PUT } from "./route"

const put = (body: unknown) =>
  PUT(new NextRequest("http://localhost/api/asset-finance/entities/ent-1/financials-evidence", { method: "PUT", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "ent-1" }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  m.session.role = "CREDIT_OFFICER"
  m.flag.on = true
  m.tx.$queryRaw.mockResolvedValue([{ id: "ent-1" }])
  m.tx.businessEntity.findFirst.mockResolvedValue({ id: "ent-1", financialsEvidenceIds: [], annualTurnover: 150_000_000, totalAssetValue: null })
  m.tx.entityDocument.findMany.mockResolvedValue([{ id: "afs-1" }])
  m.coreFindFirst.mockResolvedValue(null)
})

describe("PUT /api/asset-finance/entities/[id]/financials-evidence", () => {
  it("answers 404 when the flag is off and 403 to READONLY", async () => {
    m.flag.on = false
    expect((await put({ documentIds: ["afs-1"] })).status).toBe(404)
    m.flag.on = true
    m.session.role = "READONLY"
    expect((await put({ documentIds: ["afs-1"] })).status).toBe(403)
    expect(m.tx.businessEntity.update).not.toHaveBeenCalled()
  })

  it.each([[{}], [{ documentIds: "afs-1" }], [{ documentIds: [""] }], [{ documentIds: [1] }]])("answers 400 for %j", async (body) => {
    expect((await put(body)).status).toBe(400)
    expect(m.tx.businessEntity.update).not.toHaveBeenCalled()
  })

  it("refuses an id that is not this entity's verified, live AFS or management accounts", async () => {
    const res = await put({ documentIds: ["afs-1", "foreign-or-unverified"] })
    expect(res.status).toBe(400)
    expect((await res.json()).invalidDocumentIds).toEqual(["foreign-or-unverified"])
    expect(m.tx.entityDocument.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1", entityId: "ent-1", id: { in: ["afs-1", "foreign-or-unverified"] },
        docType: { in: ["AFS", "MANAGEMENT_ACCOUNTS"] }, verifiedAt: { not: null }, deletedAt: null,
      },
      select: { id: true },
    })
    expect(m.tx.businessEntity.update).not.toHaveBeenCalled()
  })

  it("refuses evidence for an entity with no figures to evidence", async () => {
    m.tx.businessEntity.findFirst.mockResolvedValue({ id: "ent-1", financialsEvidenceIds: [], annualTurnover: null, totalAssetValue: null })
    expect((await put({ documentIds: ["afs-1"] })).status).toBe(400)
  })

  it("locks the entity, sets the evidence and audits old and new", async () => {
    await put({ documentIds: ["afs-1", "afs-1"] })
    expect(m.tx.$queryRaw).toHaveBeenCalled()
    expect(m.tx.businessEntity.update).toHaveBeenCalledWith({
      where: { id: "ent-1", tenantId: "tenant-1" },
      data: { financialsEvidenceIds: ["afs-1"] },
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "ENTITY_FINANCIALS_EVIDENCE_SET",
      oldValue: { financialsEvidenceIds: [] },
      newValue: expect.objectContaining({ financialsEvidenceIds: ["afs-1"] }),
    }), m.tx)
  })
})
