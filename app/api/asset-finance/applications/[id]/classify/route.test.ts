import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The route and lib/asset-finance/classification.ts run for real; only Prisma,
// the session and the audit writer are stubbed.
const m = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    loanApplication: { findFirst: vi.fn(), update: vi.fn() },
    businessEntity: { findFirst: vi.fn() },
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

const classify = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/asset-finance/applications/app-1/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "app-1" }) },
  )

const application = (over: Record<string, unknown> = {}) => ({
  id: "app-1", entityId: "ent-1", status: "SUBMITTED", appliedAmount: 150_000_000, ncaRegime: null, ncaClassificationRule: null, ...over,
})
const company = (over: Record<string, unknown> = {}) => ({
  type: "COMPANY", annualTurnover: null, totalAssetValue: null, financialsEvidenceIds: [], relationships: [], ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  m.requireApiRole.mockResolvedValue({ user: { id: "officer-c", email: "c@lender.test", role: "CREDIT_OFFICER", tenantId: "tenant-1" } })
  m.tx.$queryRaw.mockResolvedValue([{ id: "app-1" }])
  m.tx.loanApplication.findFirst.mockResolvedValue(application())
  m.tx.businessEntity.findFirst.mockResolvedValue(company())
})

describe("POST /api/asset-finance/applications/[id]/classify", () => {
  it("answers 404 when the tenant has not enabled asset finance", async () => {
    m.flag.on = false
    expect((await classify({})).status).toBe(404)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it.each([
    [{ trusteeEvidenceIds: "doc-1" }],
    [{ trusteeEvidenceIds: [""] }],
    [{ trusteeEvidenceIds: [7] }],
    [[]],
  ])("answers 400 for %j", async (body) => {
    expect((await classify(body)).status).toBe(400)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("answers 404 for an application outside the tenant", async () => {
    m.tx.$queryRaw.mockResolvedValue([])
    expect((await classify({})).status).toBe(404)
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
  })

  it("refuses a natural-person application 422", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ entityId: null }))
    expect((await classify({})).status).toBe(422)
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
  })

  it("refuses 409 once the application is decided", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ status: "APPROVED" }))
    expect((await classify({})).status).toBe(409)
    expect(m.tx.businessEntity.findFirst).not.toHaveBeenCalled()
  })

  it("snapshots an unevidenced company as NCA (FINANCIALS_UNPROVEN) with its audit row", async () => {
    const res = await classify({})
    expect(res.status).toBe(200)
    expect((await res.json()).classification).toMatchObject({ regime: "NCA", rule: "FINANCIALS_UNPROVEN" })
    expect(m.tx.loanApplication.update).toHaveBeenCalledWith({
      where: { id: "app-1", tenantId: "tenant-1" },
      data: expect.objectContaining({
        ncaRegime: "NCA",
        ncaClassificationRule: "FINANCIALS_UNPROVEN",
        ncaClassificationInputs: expect.objectContaining({ entityType: "COMPANY", principalDebtCents: 150_000_000 }),
        ncaClassificationEvidenceIds: [],
        ncaClassifiedAt: expect.any(Date),
        ncaClassifiedById: "officer-c",
      }),
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_CLASSIFIED", entity: "LoanApplication", entityId: "app-1", userId: "officer-c",
      newValue: expect.objectContaining({ ncaRegime: "NCA", rule: "FINANCIALS_UNPROVEN" }),
    }), m.tx)
  })

  it("refuses a NON_NCA classification by a user without credit authority: 403, nothing written", async () => {
    m.tx.businessEntity.findFirst.mockResolvedValue(company({ annualTurnover: 200_000_000, financialsEvidenceIds: ["afs-1"] }))
    const res = await classify({})
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ classification: { regime: "NON_NCA" } })
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
  })

  it("classifies a trust with Letters of Authority and three natural trustees on its evidence", async () => {
    m.requireApiRole.mockResolvedValue({ user: { id: "admin-b", email: "b@lender.test", role: "LOAN_ADMIN", tenantId: "tenant-1" } })
    m.tx.businessEntity.findFirst.mockResolvedValue(company({
      type: "TRUST",
      annualTurnover: 200_000_000,
      financialsEvidenceIds: ["afs-1"],
      relationships: [{ trusteeKind: "NATURAL" }, { trusteeKind: "NATURAL" }, { trusteeKind: "NATURAL" }],
    }))
    const res = await classify({ trusteeEvidenceIds: [" loa-1 ", "loa-1"] })
    expect(res.status).toBe(200)
    expect((await res.json()).classification).toMatchObject({ regime: "NON_NCA", rule: "JURISTIC_OVER_THRESHOLD" })
    expect(m.tx.loanApplication.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ncaRegime: "NON_NCA", ncaClassificationEvidenceIds: ["loa-1", "afs-1"] }),
    }))
    // Only active TRUSTEE rows of this tenant count.
    expect(m.tx.businessEntity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ent-1", tenantId: "tenant-1" },
      select: expect.objectContaining({
        relationships: { where: { tenantId: "tenant-1", role: "TRUSTEE", active: true }, select: { trusteeKind: true } },
      }),
    }))
  })

  it("does not relax an NCA application by re-classifying: 409 needs an override, nothing written", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ ncaRegime: "NCA", ncaClassificationRule: "FINANCIALS_UNPROVEN" }))
    m.tx.businessEntity.findFirst.mockResolvedValue(company({ annualTurnover: 400_000_000, financialsEvidenceIds: ["afs-1"] }))
    const res = await classify({})
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ needsOverride: true, classification: { regime: "NON_NCA" } })
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(m.logAuditStrict).not.toHaveBeenCalled()
  })

  it("re-classifies a NON_NCA application to NCA without an override (stricter)", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ ncaRegime: "NON_NCA", ncaClassificationRule: "LARGE_AGREEMENT" }))
    const res = await classify({})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ previousRegime: "NON_NCA", classification: { regime: "NCA" } })
    expect(m.tx.loanApplication.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ncaRegime: "NCA" }),
    }))
  })
})
