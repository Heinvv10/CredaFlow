import { describe, expect, it } from "vitest"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { solveNcaDealStructure } from "./nca-structure"
import { assetCalculatorEvidence, createAssetPasqEvidence } from "./nca-evidence"

const solved = solveNcaDealStructure(
  { cashPriceExclVatCents: 1_000_000, vatCents: 150_000 },
  { depositCents: 150_000, tradeInCents: 0, financedFeesCents: 20_000, balloonCents: 0, preset: "MONTHLY", weights: [1, 1], firstDueDate: "2027-02-01", vatDeferralPeriodIndex: null, rate: { basis: "FIXED", fixedRate: "0.12", margin: null } },
  { annualRate: "0.12", reference: null }, "2027-01-01",
)

describe("asset NCA PASQ evidence", () => {
  it("preserves the asset schedule and keeps the initiation fee interest-free", () => {
    expect(solved.ok).toBe(true)
    if (!solved.ok) return
    const calculator = assetCalculatorEvidence(solved, 20_000)
    expect(calculator.principalCents).toBe(1_000_000)
    expect(calculator.schedule.reduce((sum, row) => sum + row.principalDueCents, 0)).toBe(calculator.principalCents)
    for (const row of calculator.schedule) {
      expect(row.principalDueCents + row.interestDueCents + row.feesDueCents).toBe(row.totalDueCents)
    }
    expect(calculator.serviceFeesCents).toBe(12_000)
    expect(calculator.totalRepayableCents).toBe(1_000_000 + calculator.totalInterestCents + 32_000)
    const noOffer = { version: "credit-life-no-offer-v1" as const, election: "DECLINED" as const, principalCents: 1_000_000, termDays: solved.termDays }
    const evidence = createAssetPasqEvidence({
      tenantId: "tenant", applicationId: "app", clientId: "client", productId: "product", termDays: solved.termDays,
      generatedAt: new Date("2026-10-13T08:00:00.000Z"), solved, initiationFeeCents: 20_000,
      creditLife: { ...noOffer, offered: false, productId: null, productName: null, insurerId: null, insurerName: null, monthlyPremiumCents: 0, disclosureSha256: createCreditLifeNoOfferDisclosureSha256(noOffer) },
    })
    expect(evidence.billing.totalRepayableCents).toBe(calculator.totalRepayableCents)
    expect(evidence.evidenceSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
