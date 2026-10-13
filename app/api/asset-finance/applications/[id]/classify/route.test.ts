import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The route and lib/asset-finance/classification.ts run for real; only Prisma,
// the session and the audit writers are stubbed.
const m = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    loanApplication: { findFirst: vi.fn(), update: vi.fn() },
    businessEntity: { findFirst: vi.fn() },
    entityDocument: { findMany: vi.fn() },
    ncaRegimeOverride: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  }
  return {
    tx,
    flag: { on: true },
    transaction: vi.fn(),
    transactionError: { current: null as Error | null },
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
    $transaction: async (fn: (tx: unknown) => unknown) => {
      m.transaction()
      if (m.transactionError.current) throw m.transactionError.current
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
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))

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
  id: "app-1", entityId: "ent-1", status: "SUBMITTED", appliedAmount: 150_000_000, productId: "prod-1", ncaRegime: null,
  ncaClassificationRule: null, ...over,
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
  m.tx.entityDocument.findMany.mockResolvedValue([])
  m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(null)
  m.tx.ncaRegimeOverride.create.mockResolvedValue({ id: "ov-new" })
  m.transactionError.current = null
})

/** A company the classifier puts outside the Act (R2m turnover, evidenced). */
const largeCompany = () => company({ annualTurnover: 200_000_000, financialsEvidenceIds: ["afs-1"] })

describe("POST /api/asset-finance/applications/[id]/classify", () => {
  it("answers 404 when the tenant has not enabled asset finance", async () => {
    m.flag.on = false
    expect((await classify({})).status).toBe(404)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("answers 404 for an application outside the tenant", async () => {
    m.tx.$queryRaw.mockResolvedValue([])
    expect((await classify({})).status).toBe(404)
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
  })

  it("refuses a natural-person application 422 and audits the refusal", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ entityId: null }))
    expect((await classify({})).status).toBe(422)
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_CLASSIFY_REFUSED", entity: "LoanApplication", entityId: "app-1", userId: "officer-c",
      reason: "not_entity_borrower", status: 422,
    }))
  })

  it("refuses 409 once the application is decided, and audits the refusal", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ status: "APPROVED" }))
    expect((await classify({})).status).toBe(409)
    expect(m.tx.businessEntity.findFirst).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_CLASSIFY_REFUSED", entityId: "app-1", reason: "regime_frozen", status: 409,
    }))
  })

  it("answers 409 when the database refuses the write (SQLSTATE 23514), not 500", async () => {
    m.transactionError.current = Object.assign(new Error("ERROR: A classified application's borrower cannot change"), { code: "23514" })
    const res = await classify({})
    expect(res.status).toBe(409)
    expect(m.auditRefusal).not.toHaveBeenCalled()
  })

  it("lets any other database failure through", async () => {
    m.transactionError.current = new Error("connection reset")
    await expect(classify({})).rejects.toThrow("connection reset")
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

  it("records a NON_NCA result as NCA plus a PENDING override in the classifier's name, whoever classifies", async () => {
    m.tx.businessEntity.findFirst.mockResolvedValue(largeCompany())
    const res = await classify({})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ regime: "NCA", previousRegime: null, pendingOverrideId: "ov-new", classification: { regime: "NON_NCA", rule: "JURISTIC_OVER_THRESHOLD" } })
    // The snapshot is the classifier's; the effective regime is NCA until approved.
    expect(m.tx.loanApplication.update).toHaveBeenCalledWith({
      where: { id: "app-1", tenantId: "tenant-1" },
      data: expect.objectContaining({ ncaRegime: "NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD", ncaClassificationEvidenceIds: ["afs-1"] }),
    })
    expect(m.tx.ncaRegimeOverride.create).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-1", applicationId: "app-1", fromRegime: "NCA", toRegime: "NON_NCA", requestedById: "officer-c",
        reason: `Classifier: JURISTIC_OVER_THRESHOLD — ${body.classification.reason}`, source: "CLASSIFIER",
        // The application as classified: what the second person approves.
        approvedEntityId: "ent-1", approvedAppliedAmount: 150_000_000, approvedProductId: "prod-1",
        approvedClassificationRule: "JURISTIC_OVER_THRESHOLD",
      },
      select: { id: true },
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_OVERRIDE_REQUESTED", entity: "NcaRegimeOverride", entityId: "ov-new", userId: "officer-c",
    }), m.tx)
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_CLASSIFIED",
      newValue: expect.objectContaining({ ncaRegime: "NCA", classifierRegime: "NON_NCA", pendingOverrideId: "ov-new" }),
    }), m.tx)
  })

  it("re-uses the open PENDING override when its snapshot is the application as classified", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ ncaRegime: "NCA", ncaClassificationRule: "FINANCIALS_UNPROVEN" }))
    m.tx.businessEntity.findFirst.mockResolvedValue(largeCompany())
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue({
      id: "ov-open", source: "CLASSIFIER", approvedEntityId: "ent-1", approvedAppliedAmount: 150_000_000,
      approvedProductId: "prod-1", approvedClassificationRule: "JURISTIC_OVER_THRESHOLD",
    })
    const res = await classify({})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ regime: "NCA", pendingOverrideId: "ov-open", supersededOverrideId: null })
    expect(m.tx.ncaRegimeOverride.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", applicationId: "app-1", status: "PENDING" },
    }))
    expect(m.tx.ncaRegimeOverride.create).not.toHaveBeenCalled()
    expect(m.tx.ncaRegimeOverride.update).not.toHaveBeenCalled()
  })

  it("writes nothing for a NON_NCA application the classifier puts on the same NON_NCA rule, and says so", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ ncaRegime: "NON_NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD" }))
    m.tx.businessEntity.findFirst.mockResolvedValue(largeCompany())
    const res = await classify({})
    expect(await res.json()).toMatchObject({ regime: "NON_NCA", pendingOverrideId: null, unchanged: true })
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(m.tx.ncaRegimeOverride.create).not.toHaveBeenCalled()
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_CLASSIFIED", newValue: expect.objectContaining({ ncaRegime: "NON_NCA", unchanged: true }),
    }), m.tx)
  })

  it("classifies a trust with Letters of Authority and three natural trustees on its evidence", async () => {
    m.requireApiRole.mockResolvedValue({ user: { id: "admin-b", email: "b@lender.test", role: "LOAN_ADMIN", tenantId: "tenant-1" } })
    m.tx.businessEntity.findFirst.mockResolvedValue(company({
      type: "TRUST",
      annualTurnover: 200_000_000,
      financialsEvidenceIds: ["afs-1"],
      relationships: [{ trusteeKind: "NATURAL" }, { trusteeKind: "NATURAL" }, { trusteeKind: "NATURAL" }],
    }))
    // Trustee evidence is the entity's verified Letters of Authority only.
    m.tx.entityDocument.findMany.mockResolvedValue([{ id: "loa-1" }])
    const res = await classify({})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      regime: "NCA", pendingOverrideId: "ov-new", classification: { regime: "NON_NCA", rule: "JURISTIC_OVER_THRESHOLD" },
    })
    expect(m.tx.loanApplication.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ncaRegime: "NCA", ncaClassificationEvidenceIds: ["loa-1", "afs-1"] }),
    }))
    // Only active TRUSTEE rows of this tenant count.
    expect(m.tx.businessEntity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ent-1", tenantId: "tenant-1" },
      select: expect.objectContaining({
        relationships: { where: { tenantId: "tenant-1", role: "TRUSTEE", active: true }, select: { trusteeKind: true } },
      }),
    }))
  })

  it("re-classifies a NON_NCA application to NCA without an override: regime first, then the snapshot", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ ncaRegime: "NON_NCA", ncaClassificationRule: "LARGE_AGREEMENT" }))
    const res = await classify({})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ previousRegime: "NON_NCA", regime: "NCA", pendingOverrideId: null, classification: { regime: "NCA" } })
    // The snapshot is frozen while NON_NCA: the regime goes back to NCA on its own first.
    expect(m.tx.loanApplication.update.mock.calls.map(([args]) => args.data)).toEqual([
      { ncaRegime: "NCA" },
      expect.objectContaining({ ncaRegime: "NCA", ncaClassificationRule: "FINANCIALS_UNPROVEN" }),
    ])
    expect(m.tx.ncaRegimeOverride.create).not.toHaveBeenCalled()
  })
})
