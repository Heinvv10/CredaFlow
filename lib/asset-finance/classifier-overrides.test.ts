import { beforeEach, describe, expect, it, vi } from "vitest"

// classifyApplication and the override reconciliation run for real; only the
// transaction client and the audit writer are stubbed. The database side of
// these rules is proven in regime-override.integration.test.ts.
const m = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(),
    loanApplication: { findFirst: vi.fn(), update: vi.fn() },
    businessEntity: { findFirst: vi.fn() },
    ncaRegimeOverride: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
  logAuditStrict: vi.fn(),
}))

vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))

import { classifyApplication, type RegimeTx } from "./classification"
import { SUPERSEDED_OVERRIDE_NOTE } from "./override-snapshot"

const run = () =>
  classifyApplication(m.tx as unknown as RegimeTx, { tenantId: "tenant-1", applicationId: "app-1", userId: "officer-c" })

const application = (over: Record<string, unknown> = {}) => ({
  id: "app-1", entityId: "ent-1", status: "UNDER_REVIEW", appliedAmount: 150_000_000, productId: "prod-1",
  ncaRegime: "NCA", ncaClassificationRule: "FINANCIALS_UNPROVEN", ncaClassifiedAt: new Date("2026-10-01T08:00:00Z"), ...over,
})
const unevidenced = { type: "COMPANY", annualTurnover: null, totalAssetValue: null, financialsEvidenceIds: [], relationships: [] }
/** R2m turnover, evidenced: JURISTIC_OVER_THRESHOLD, NON_NCA. */
const evidenced = { ...unevidenced, annualTurnover: 200_000_000, financialsEvidenceIds: ["afs-1"] }
const openOverride = (over: Record<string, unknown> = {}) => ({ id: "ov-open", source: "CLASSIFIER", ...over })

const rejectedAsSuperseded = (overrideId: string) =>
  expect(m.tx.ncaRegimeOverride.update).toHaveBeenCalledWith({
    where: { id: overrideId },
    data: { status: "REJECTED", decidedById: "officer-c", decidedAt: expect.any(Date), decisionNote: SUPERSEDED_OVERRIDE_NOTE },
  })

beforeEach(() => {
  vi.clearAllMocks()
  m.tx.$queryRaw.mockResolvedValue([{ id: "app-1" }])
  m.tx.loanApplication.findFirst.mockResolvedValue(application())
  m.tx.businessEntity.findFirst.mockResolvedValue(unevidenced)
  m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(null)
  m.tx.ncaRegimeOverride.create.mockResolvedValue({ id: "ov-new" })
})

describe("classifyApplication: open overrides follow the latest classification", () => {
  it("an NCA result rejects the classifier's open request as superseded, in the classifying user's name", async () => {
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(openOverride())
    expect(await run()).toMatchObject({ regime: "NCA", pendingOverrideId: null, supersededOverrideId: "ov-open" })
    rejectedAsSuperseded("ov-open")
    expect(m.tx.ncaRegimeOverride.create).not.toHaveBeenCalled()
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_OVERRIDE_DECIDED", entityId: "ov-open", userId: "officer-c",
      newValue: expect.objectContaining({ status: "REJECTED", superseded: true }),
    }), m.tx)
  })

  it("an NCA result leaves a manual open request for its decider", async () => {
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(openOverride({ source: "MANUAL" }))
    expect(await run()).toMatchObject({ regime: "NCA", pendingOverrideId: null, supersededOverrideId: null })
    expect(m.tx.ncaRegimeOverride.update).not.toHaveBeenCalled()
  })

  it.each(["MANUAL", "CLASSIFIER"])("a NON_NCA result rejects any open %s request (it named an earlier run) and opens a fresh one", async (source) => {
    m.tx.businessEntity.findFirst.mockResolvedValue(evidenced)
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(openOverride({ source }))
    expect(await run()).toMatchObject({ regime: "NCA", pendingOverrideId: "ov-new", supersededOverrideId: "ov-open" })
    rejectedAsSuperseded("ov-open")
    expect(m.tx.ncaRegimeOverride.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: "CLASSIFIER", requestedById: "officer-c", approvedEntityId: "ent-1", approvedAppliedAmount: 150_000_000,
        approvedProductId: "prod-1", approvedClassificationRule: "JURISTIC_OVER_THRESHOLD",
        approvedClassifiedAt: m.tx.loanApplication.update.mock.calls[0][0].data.ncaClassifiedAt,
      }),
      select: { id: true },
    })
    // The rejection precedes the new request: one PENDING slot per application.
    expect(m.tx.ncaRegimeOverride.update.mock.invocationCallOrder[0])
      .toBeLessThan(m.tx.ncaRegimeOverride.create.mock.invocationCallOrder[0])
  })

  it("a NON_NCA application re-classified to a different NON_NCA rule goes back to NCA and needs a new approval", async () => {
    m.tx.loanApplication.findFirst.mockResolvedValue(application({ ncaRegime: "NON_NCA", ncaClassificationRule: "LARGE_AGREEMENT" }))
    m.tx.businessEntity.findFirst.mockResolvedValue(evidenced)
    expect(await run()).toMatchObject({
      previousRegime: "NON_NCA", regime: "NCA", pendingOverrideId: "ov-new", unchanged: false,
      classification: { regime: "NON_NCA", rule: "JURISTIC_OVER_THRESHOLD" },
    })
    expect(m.tx.loanApplication.update.mock.calls.map(([args]) => args.data)).toEqual([
      { ncaRegime: "NCA" },
      expect.objectContaining({ ncaRegime: "NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD" }),
    ])
    expect(m.tx.ncaRegimeOverride.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fromRegime: "NCA", toRegime: "NON_NCA", approvedClassificationRule: "JURISTIC_OVER_THRESHOLD" }),
    }))
  })
})
