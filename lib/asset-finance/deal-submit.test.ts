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
  const clientId = null as string | null
  const entityId = "entity-1" as string | null
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "app-1" }]),
    assetFinanceDeal: {
      findFirst: vi.fn(async () => ({ id: "deal-1", applicationId: "app-1", status: dealStatus, application: { status: appStatus, clientId, entityId, ncaRegime: "NCA", ncaClassificationRule: "FINANCIALS_UNPROVEN" } })),
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

  it("classifies as the submitting user; an NCA result now proceeds down the NCA path", async () => {
    m.classify.mockResolvedValue(classified("NCA", "FINANCIALS_UNPROVEN", null))
    const { tx, asTx } = fakeTx()
    const result = await submitDeal(asTx, actor, "deal-1")
    expect(result).toEqual({ kind: "submitted", awaitingRegimeApproval: false, regime: "NCA", rule: "FINANCIALS_UNPROVEN" })
    expect(m.classify).toHaveBeenCalledWith(asTx, expect.objectContaining({ applicationId: "app-1", userId: "officer-a" }))
    expect(tx.loanApplication.update).toHaveBeenCalledWith({
      where: { id: "app-1", tenantId: "tenant-1" },
      data: { status: "SUBMITTED", submittedAt: expect.any(Date) },
    })
    expect(tx.assetFinanceDeal.update).toHaveBeenCalledWith({ where: { id: "deal-1", tenantId: "tenant-1" }, data: { status: "SUBMITTED" } })
    expect(actions(tx)).toEqual(["ASSET_DEAL_SUBMITTED"])
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

  it("does not run the juristic classifier for a natural-person borrower", async () => {
    const { tx, asTx } = fakeTx()
    tx.assetFinanceDeal.findFirst.mockResolvedValue({
      id: "deal-1", applicationId: "app-1", status: "DRAFT",
      application: { status: "DRAFT", clientId: "client-1", entityId: null, ncaRegime: "NCA", ncaClassificationRule: "NATURAL_PERSON_NCA" },
    })
    expect(await submitDeal(asTx, actor, "deal-1")).toEqual({
      kind: "submitted", awaitingRegimeApproval: false, regime: "NCA", rule: "NATURAL_PERSON_NCA",
    })
    expect(m.classify).not.toHaveBeenCalled()
  })
})
