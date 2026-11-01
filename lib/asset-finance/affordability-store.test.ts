import { describe, expect, it, vi } from "vitest"
import type { RegimeTx } from "./classification"

vi.mock("@/lib/audit", () => ({ AuditAction: { ASSET_AFFORDABILITY_ASSESSED: "ASSET_AFFORDABILITY_ASSESSED" }, logAuditStrict: vi.fn() }))
vi.mock("./deal-submit", () => ({ lockDeal: vi.fn(async () => true) }))

import { recordAssetFinanceAffordability } from "./affordability-store"

function fakeTx(ncaRegime: "NCA" | "NON_NCA") {
  const applicationUpdate = vi.fn(async () => ({}))
  const tx = {
    assetFinanceDeal: {
      findFirst: vi.fn(async () => ({
        id: "deal", applicationId: "app", status: "SUBMITTED", baseInstalmentCents: 100_000, clientId: null, entityId: "entity",
        application: { ncaRegime, affordabilityNDI: null },
        financials: { turnoverCents: 120_000_000, avgMonthlyCreditsCents: 10_000_000, existingDebtServiceCents: 500_000 },
        affordabilityAssessment: null,
      })),
    },
    assetFinanceAffordabilityAssessment: { upsert: vi.fn(async () => ({})) },
    loanApplication: { update: applicationUpdate },
  } as unknown as RegimeTx
  return { tx, applicationUpdate }
}

const actor = { tenantId: "t", userId: "u", userEmail: "u@example.test" }
const NOTE = "Synthetic attestation of affordability."

describe("recordAssetFinanceAffordability: section 81 stamp", () => {
  it("stamps the application as reckless-lending assessed for an NCA deal", async () => {
    const { tx, applicationUpdate } = fakeTx("NCA")
    expect((await recordAssetFinanceAffordability(tx, actor, "deal", NOTE)).kind).toBe("recorded")
    expect(applicationUpdate.mock.calls[0]).toEqual([expect.objectContaining({ data: expect.objectContaining({ recklessLendingAssessed: true, recklessLendingAssessedById: "u", recklessLendingNote: NOTE }) })])
  })

  it("does not stamp section 81 on a NON_NCA deal, which the NCA does not govern", async () => {
    const { tx, applicationUpdate } = fakeTx("NON_NCA")
    expect((await recordAssetFinanceAffordability(tx, actor, "deal", NOTE)).kind).toBe("recorded")
    const data = (applicationUpdate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data
    expect(data).not.toHaveProperty("recklessLendingAssessed")
    expect(data).not.toHaveProperty("recklessLendingNote")
    expect(data).toHaveProperty("netDisposableIncome")
  })
})
