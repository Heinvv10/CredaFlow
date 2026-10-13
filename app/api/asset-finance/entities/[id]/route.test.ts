import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Route, role guard and flag gate are real; session, Prisma and audit stubbed.
const m = vi.hoisted(() => ({
  session: { role: "CREDIT_OFFICER" as string },
  flag: { on: true },
  tx: {
    $queryRaw: vi.fn(),
    businessEntity: { findFirst: vi.fn(), update: vi.fn() },
  },
  findFirst: vi.fn(),
  logAuditStrict: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-1", email: "officer@lender.test", role: m.session.role, tenantId: "tenant-1" } })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    businessEntity: { findFirst: m.findFirst },
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

import { PATCH } from "./route"

const BODY = {
  type: "COMPANY",
  legalName: "TEST Synthetic Plant Hire (Pty) Ltd",
  registrationNumber: "2015/123456/07",
  annualTurnover: 150_000_000,
  financialYearEnd: "2026-02-28",
}
const before = (over: Record<string, unknown> = {}) => ({
  id: "ent-1", tenantId: "tenant-1", type: "COMPANY", legalName: BODY.legalName, registrationNumber: BODY.registrationNumber,
  annualTurnover: 150_000_000, totalAssetValue: null, financialYearEnd: new Date("2026-02-28T00:00:00Z"),
  financialsEvidenceIds: ["afs-1"], ...over,
})
const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost/api/asset-finance/entities/ent-1", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "ent-1" }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  m.session.role = "CREDIT_OFFICER"
  m.flag.on = true
  m.tx.$queryRaw.mockResolvedValue([{ id: "ent-1" }])
  m.tx.businessEntity.findFirst.mockResolvedValue(before())
  m.findFirst.mockResolvedValue({ ...before(), createdAt: new Date(), updatedAt: new Date() })
})

describe("PATCH /api/asset-finance/entities/[id]", () => {
  it("answers 404 when the flag is off", async () => {
    m.flag.on = false
    expect((await patch(BODY)).status).toBe(404)
    expect(m.tx.businessEntity.update).not.toHaveBeenCalled()
  })

  it("refuses READONLY 403", async () => {
    m.session.role = "READONLY"
    expect((await patch(BODY)).status).toBe(403)
    expect(m.tx.businessEntity.update).not.toHaveBeenCalled()
  })

  it("answers 400 for an invalid body and for a change of type", async () => {
    expect((await patch({ ...BODY, legalName: "" })).status).toBe(400)
    const res = await patch({ ...BODY, type: "CC" })
    expect(res.status).toBe(400)
    expect((await res.json()).fields).toHaveProperty("type")
    expect(m.tx.businessEntity.update).not.toHaveBeenCalled()
  })

  it("answers 404 for an entity outside the tenant", async () => {
    m.tx.$queryRaw.mockResolvedValue([])
    expect((await patch(BODY)).status).toBe(404)
  })

  it("keeps the evidence when the figures are unchanged", async () => {
    expect((await patch({ ...BODY, tradingName: "TEST Plant" })).status).toBe(200)
    const data = m.tx.businessEntity.update.mock.calls[0][0].data
    expect(data).toMatchObject({ tradingName: "TEST Plant" })
    expect(data).not.toHaveProperty("financialsEvidenceIds")
  })

  it("clears the evidence when the turnover changes, and audits old and new", async () => {
    expect((await patch({ ...BODY, annualTurnover: 90_000_000 })).status).toBe(200)
    expect(m.tx.businessEntity.update).toHaveBeenCalledWith({
      where: { id: "ent-1", tenantId: "tenant-1" },
      data: expect.objectContaining({ annualTurnover: 90_000_000, financialsEvidenceIds: [] }),
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BUSINESS_ENTITY_UPDATED",
        oldValue: expect.objectContaining({ annualTurnover: 150_000_000, financialsEvidenceIds: ["afs-1"] }),
        newValue: expect.objectContaining({ annualTurnover: 90_000_000, financialsEvidenceIds: [] }),
      }),
      m.tx,
    )
  })
})
