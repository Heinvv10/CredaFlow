import { describe, expect, it, vi } from "vitest"
import { applicationDebt, client, debt, product } from "@/lib/affordability/__fixtures__/approval-evidence"
import { loadOwnLenderDebts, ownAwareDebtTotal, ownAwareSubmissionSnapshot } from "./own-lender-debt-load"

function db() {
  return {
    loan: { findMany: vi.fn(async () => [{
      id: "loan-1", clientId: "client-1", reference: "LN-1", status: "ACTIVE", outstandingPrincipal: 900_000, daysInArrears: 0, arrearsAmount: 0,
      repaymentSchedule: [{ totalDue: 140_000 }, { totalDue: 120_000 }],
    }]) },
    loanApplication: { findMany: vi.fn(async () => [{
      id: "app-2", reference: "APP-2", approvedAmount: 200_000,
      affordabilityResult: { schemaVersion: 3, approval: { inputs: { proposedInstalmentCents: 30_000 } } },
    }]) },
    tenant: { findUnique: vi.fn(async () => ({ name: "acme" })) },
    tenantConfig: { findUnique: vi.fn(async () => ({ brandName: "Acme Lending", legalName: "Acme Lending (Pty) Ltd" })) },
  }
}

describe("loading the client's obligations to this lender", () => {
  it("counts open loans that still owe and applications approved but not paid out, never the one being assessed", async () => {
    const d = db()
    const own = await loadOwnLenderDebts(d as never, "t1", "client-1", "app-1")
    expect(own.loans.map((loan) => [loan.id, loan.instalmentCents])).toEqual([["loan-1", 120_000], ["application:app-2", 30_000]])
    expect(d.loanApplication.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t1", clientId: "client-1", status: "APPROVED", loan: null, id: { not: "app-1" } },
    }))
    expect(d.loan.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ applicationId: { not: "app-1" } }) }))
    expect(ownAwareDebtTotal([{ monthlyInstalment: 50_000 }], own)).toBe(50_000 + 120_000 + 30_000)
  })

  it("submits an application on an NDI that counts them", async () => {
    const snapshot = await ownAwareSubmissionSnapshot(db() as never, "t1", "client-1", {
      capturedAt: new Date("2026-07-20T09:00:00.000Z"), capturedById: "officer-1", client,
      applicationDebts: [applicationDebt], clientDebts: [debt],
      application: { appliedAmount: 500_000, appliedTermDays: 90, productId: "product-1", initiationFeePayment: "DEFERRED", creditLifeMonthlyPremiumCents: 0 },
      product,
    })
    expect(snapshot.inputs).toMatchObject({ applicationDebtCents: 50_000 + 150_000, clientDebtCents: 50_000 + 150_000, declaredDebtCents: 200_000 })
  })
})
