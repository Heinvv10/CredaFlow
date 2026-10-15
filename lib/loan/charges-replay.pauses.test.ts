import { describe, expect, it, vi } from "vitest"
import { loadChargesReplay } from "./charges-replay"

const d = (ymd: string) => new Date(`${ymd}T12:00:00+02:00`)
const ref = { tenantId: "t1", loanId: "loan-1" }

// R2,000 NCA bullet due 1 Sep, 5% pm: R30.00 default interest to the 11th.
const loan = {
  principal: 200_000, interestRatePm: 0.05, ncaRegime: "NCA", maturityDate: d("2026-09-01"), status: "ACTIVE",
  closedAt: null, writeOffAt: null, defaultChargesExempt: false, defaultChargesExemptEndedAt: null,
  monthlyServiceFee: 6_900, nonNcaDefaultInterestMargin: null, nonNcaCollectionFeeCents: null,
  product: { code: "MICRO", monthlyServiceFee: 6_900 }, contractRates: [],
  tenant: { config: { defaultChargesEnabled: true, defaultChargesStartedAt: d("2026-01-01"), defaultChargesStoppedAt: null } },
  repaymentSchedule: [{
    dueDate: d("2026-09-01"), principalDue: 200_000, interestDue: 10_000, feesDue: 6_900,
    creditLifePremiumDue: 0, totalDue: 216_900,
  }],
}
const tx = {
  loan: { findUnique: vi.fn().mockResolvedValue(loan) },
  payment: { findMany: vi.fn().mockResolvedValue([]) },
  complianceRecord: { findMany: vi.fn().mockResolvedValue([]) },
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asTx = tx as any

describe("loadChargesReplay — pauses", () => {
  it("passes the pauses to the engine, for the replay and for every replayAt", async () => {
    const pauses = [{ from: d("2026-09-04"), until: d("2026-09-06") }]
    const plain = (await loadChargesReplay(asTx, ref, d("2026-09-11")))!
    const paused = (await loadChargesReplay(asTx, ref, d("2026-09-11"), { pauses }))!
    expect(plain.result.interestAccrued).toBe(3_000)
    expect(paused.result.interestAccrued).toBe(2_000)
    expect(paused.replayAt(d("2026-09-11")).interestAccrued).toBe(2_000)
  })
})
