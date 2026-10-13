import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ classify: vi.fn() }))
vi.mock("./classification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./classification")>()),
  classifyApplication: m.classify,
}))

import type { RegimeTx } from "./classification"
import { submitDeal } from "./deal-submit"

const actor = { tenantId: "tenant-1", userId: "officer-a", userEmail: "o@lender.test" }

function fakeTx(dealStatus = "DRAFT", appStatus = "DRAFT", pendingOverride = false) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "app-1" }]),
    assetFinanceDeal: {
      findFirst: vi.fn(async () => ({ id: "deal-1", applicationId: "app-1", status: dealStatus, application: { status: appStatus } })),
      update: vi.fn(async () => ({})),
    },
    ncaRegimeOverride: { findFirst: vi.fn(async () => (pendingOverride ? { id: "ovr-1" } : null)) },
    loanApplication: { update: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  }
  return { tx, asTx: tx as unknown as RegimeTx }
}

const classified = (classifierRegime: "NCA" | "NON_NCA", rule: string, pendingOverrideId: string | null) => ({
  kind: "classified",
  classification: { regime: classifierRegime, rule, reason: "synthetic", inputs: {}, evidenceIds: [] },
  previousRegime: null,
  regime: "NCA",
  pendingOverrideId,
})

const actions = (tx: ReturnType<typeof fakeTx>["tx"]) =>
  tx.auditLog.create.mock.calls.map((call) => (call as unknown as [{ data: { action: string } }])[0].data.action)

describe("submitDeal", () => {
  beforeEach(() => vi.clearAllMocks())

  it("classifies as the submitting user; an NCA result with no pending override refuses the deal and audits it", async () => {
    m.classify.mockResolvedValue(classified("NCA", "FINANCIALS_UNPROVEN", null))
    const { tx, asTx } = fakeTx()
    const result = await submitDeal(asTx, actor, "deal-1")
    const reason = "NCA applies (Turnover and asset value not proven by verified financial statements)"
    expect(result).toEqual({ kind: "refused_nca", reason, rule: "FINANCIALS_UNPROVEN" })
    expect(m.classify).toHaveBeenCalledWith(asTx, expect.objectContaining({ applicationId: "app-1", userId: "officer-a" }))
    expect(tx.loanApplication.update).toHaveBeenCalledWith({
      where: { id: "app-1", tenantId: "tenant-1" },
      data: { status: "DECLINED", decisionReason: reason, submittedAt: expect.any(Date) },
    })
    expect(tx.assetFinanceDeal.update).toHaveBeenCalledWith({ where: { id: "deal-1", tenantId: "tenant-1" }, data: { status: "REFUSED_NCA" } })
    expect(actions(tx)).toEqual(["ASSET_DEAL_SUBMITTED", "ASSET_DEAL_REFUSED_NCA"])
  })

  it("a NON_NCA classifier result leaves a pending override: SUBMITTED, awaiting the second approver", async () => {
    m.classify.mockResolvedValue(classified("NON_NCA", "JURISTIC_OVER_THRESHOLD", "ovr-1"))
    const { tx, asTx } = fakeTx("DRAFT", "DRAFT", true)
    expect(await submitDeal(asTx, actor, "deal-1")).toEqual({
      kind: "submitted", awaitingRegimeApproval: true, regime: "NCA", rule: "JURISTIC_OVER_THRESHOLD",
    })
    expect(tx.loanApplication.update).toHaveBeenCalledWith({
      where: { id: "app-1", tenantId: "tenant-1" }, data: { status: "SUBMITTED", submittedAt: expect.any(Date) },
    })
    expect(tx.assetFinanceDeal.update).toHaveBeenCalledWith({ where: { id: "deal-1", tenantId: "tenant-1" }, data: { status: "SUBMITTED" } })
    expect(actions(tx)).toEqual(["ASSET_DEAL_SUBMITTED"])
  })

  it("a manual pending override also keeps an NCA classifier result from being refused", async () => {
    m.classify.mockResolvedValue(classified("NCA", "TRUST_FEWER_THAN_THREE_NATURAL_TRUSTEES", null))
    const { asTx } = fakeTx("DRAFT", "DRAFT", true)
    expect(await submitDeal(asTx, actor, "deal-1")).toMatchObject({ kind: "submitted", awaitingRegimeApproval: true })
  })

  it("refuses a deal that is not DRAFT without classifying", async () => {
    const { tx, asTx } = fakeTx("SUBMITTED", "SUBMITTED")
    expect(await submitDeal(asTx, actor, "deal-1")).toEqual({ kind: "not_draft", status: "SUBMITTED" })
    expect(m.classify).not.toHaveBeenCalled()
    expect(tx.loanApplication.update).not.toHaveBeenCalled()
  })
})
