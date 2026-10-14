import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RegimeTx } from "./classification"
import { recordAssetCreditLifeElection } from "./nca-credit-life"

const app = { id: "app-1", appliedAmount: 1_000_000, appliedTermDays: 365, pasqDocumentId: null }
const args = { tenantId: "tenant-1", clientId: "client-1", clientEmail: "client@test.invalid", dealId: "deal-1", election: "DECLINED" as const }

function fake(offer: object | null = null) {
  const tx = {
    assetFinanceDeal: { findFirst: vi.fn(async () => ({ status: "SUBMITTED", application: app })) },
    insuranceProduct: { findFirst: vi.fn(async () => offer) },
    loanApplication: { update: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  }
  return { tx, asTx: tx as unknown as RegimeTx }
}

describe("asset credit-life election", () => {
  beforeEach(() => vi.clearAllMocks())

  it("records the explicit no-offer disclosure when no eligible product exists", async () => {
    const { tx, asTx } = fake()
    expect(await recordAssetCreditLifeElection(asTx, args)).toEqual({ kind: "recorded", offered: false, monthlyPremiumCents: 0 })
    expect(tx.loanApplication.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      creditLifeElection: "DECLINED", creditLifeProductId: null, creditLifeDisclosureVersion: "credit-life-no-offer-v1",
      creditLifeDisclosureSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }) }))
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "ASSET_CREDIT_LIFE_ELECTED" }) })
  })

  it("binds an accepted election to the exact configured product and insurer", async () => {
    const { tx, asTx } = fake({ id: "product-1", name: "TEST Credit Life", insurerId: "insurer-1", insurer: { name: "TEST Insurer" } })
    const result = await recordAssetCreditLifeElection(asTx, { ...args, election: "ACCEPTED" })
    expect(result).toEqual({ kind: "recorded", offered: true, monthlyPremiumCents: 4_500 })
    expect(tx.loanApplication.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      creditLifeElection: "ACCEPTED", creditLifeProductId: "product-1", creditLifeInsurerId: "insurer-1", creditLifeMonthlyPremiumCents: 4_500,
    }) }))
  })

  it("refuses acceptance when there is no offer", async () => {
    const { tx, asTx } = fake()
    expect(await recordAssetCreditLifeElection(asTx, { ...args, election: "ACCEPTED" })).toEqual({ kind: "offer_required" })
    expect(tx.loanApplication.update).not.toHaveBeenCalled()
  })
})
