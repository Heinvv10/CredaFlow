import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import { syncLoanCharges } from "./charges-sync"
import { loadChargesReplay } from "./charges-replay"
const d = (day: string) => new Date(`${day}T12:00:00+02:00`)
const stop = d("2026-09-20")
const history = [
  { type: "DEFAULT_INTEREST", day: d("2026-09-10"), amount: 1000, sourceId: null },
  { type: "COLLECTION_FEE", day: d("2026-09-10"), amount: 2000, sourceId: null },
  { type: "RECOVERY_COST", day: d("2026-09-10"), amount: 3000, sourceId: "old-forgiven" },
]
function fixture(sameDay = false, retry = false, acceptedBeforeStop = false) {
  const eventDay = sameDay ? "2026-09-20" : "2026-09-21"
  const acceptedAt = new Date(`${eventDay}T${acceptedBeforeStop ? "11" : "13"}:00:00+02:00`)
  const old = { id: "historic", amount: 3000, receivedAt: sameDay ? stop : d("2026-09-10"), defaultInterestAllocated: 1000, chargeFeesAllocated: 2000 }
  const fresh = { id: "actual-sale-proceeds", amount: 10_000, receivedAt: new Date(`${eventDay}T14:00:00+02:00`), defaultInterestAllocated: 0, chargeFeesAllocated: retry ? 10_000 : 0 }
  const loan = { id: "lease", tenantId: "tenant", principal: 0, interestRatePm: 0.01, ncaRegime: "NON_NCA", startDate: d("2026-01-01"), maturityDate: d("2026-12-01"), status: "COMPLETED", closedAt: d("2026-09-15"), writeOffAt: null, defaultChargesExempt: false, defaultChargesExemptEndedAt: null, monthlyServiceFee: 0,
    nonNcaDefaultInterestMargin: new Prisma.Decimal("0.02"), nonNcaCollectionFeeCents: 25_000, product: { code: "LEASE", monthlyServiceFee: 0 }, contractRates: [],
    tenant: { config: { defaultChargesEnabled: false, defaultChargesStartedAt: d("2026-01-01"), defaultChargesStoppedAt: stop } },
    repaymentSchedule: [{ id: "zero-capital", dueDate: d("2026-12-01"), principalDue: 0, interestDue: 0, feesDue: 0, totalDue: 0 }],
    recoveries: [
      { id: "assessed", chargesFrozenFrom: null, chargesFrozenUntil: null, chargedCostsCents: null, leaseTerminationQuote: { status: "ACCEPTED", acceptedAt, quotedOn: new Date(eventDay), reasonableAssessment: { context: "lessor_breach_cpa48_contract9_10", chargedCostsCents: 25_000 } }, costs: [{ id: "new-certified", grossCents: 40_000 }] },
      { id: "ordinary", chargesFrozenFrom: new Date(eventDay), chargesFrozenUntil: null, costs: [{ id: "ordinary-forgiven", grossCents: 9999 }] },
    ],
  }
  const postings = retry ? [...history, { type: "RECOVERY_COST", day: new Date(eventDay), amount: 25_000, sourceId: "new-certified" }] : history
  const tx = { loan: { findUnique: vi.fn().mockResolvedValue(loan) }, payment: { findMany: vi.fn().mockResolvedValue([old, fresh]) }, loanCharge: { findMany: vi.fn().mockResolvedValue(postings) }, complianceRecord: { findMany: vi.fn().mockResolvedValue([]) } }
  return { tx, loan, old, fresh }
}
describe("permanent-stop history with a newly assessed CPA lessor cost", () => {
  it.each([false, true])("preserves old paid shares/forgiven history and collects only certified new debt, same-day=%s", async (sameDay) => {
    const { tx } = fixture(sameDay)
    const result = (await loadChargesReplay(tx as never, { tenantId: "tenant", loanId: "lease" }, d("2026-09-25")))!.result
    expect(result).toMatchObject({ interestOutstanding: 0, interestAccrued: 1000, interestPaid: 1000, feesOutstanding: 15_000, feesPaid: 12_000, feesAccrued: 30_000, scheduleAllocated: 0 })
    expect(result.receiptSplits).toEqual([{ receiptId: "historic", toDefaultInterest: 1000, toFees: 2000, toSchedule: 0 }, { receiptId: "actual-sale-proceeds", toDefaultInterest: 0, toFees: 10_000, toSchedule: 0 }])
    expect(result.postings).toHaveLength(4)
    expect(result.postings.filter((row) => row.sourceId === "new-certified")).toHaveLength(1)
    expect(result.postings.some((row) => row.sourceId === "ordinary-forgiven")).toBe(false)
  })
  it("replays a recorded certified fee payment without freezing it into old stop history or duplicating its posting", async () => {
    const { tx } = fixture(false, true)
    const replay = await loadChargesReplay(tx as never, { tenantId: "tenant", loanId: "lease" }, d("2026-09-25"))
    expect(replay!.result).toMatchObject({ feesOutstanding: 15_000, feesPaid: 12_000, feesAccrued: 30_000 })
    expect(replay!.result.postings.filter((row) => row.sourceId === "new-certified")).toHaveLength(1)
  })
  it("does not revive a cost already assessed before the permanent stop", async () => {
    const { tx } = fixture(true, false, true)
    expect((await loadChargesReplay(tx as never, { tenantId: "tenant", loanId: "lease" }, d("2026-09-25")))!.result.feesOutstanding).toBe(0)
  })
})

it("sync preserves old posting identities and paid shares while writing only new certified costs", async () => {
  const { tx, loan } = fixture()
  Object.assign(loan, { totalPaid: 0, totalInterest: 0, totalRepayable: 0, outstandingPrincipal: 0, arrearsAmount: 0, daysInArrears: 0, nextPaymentDate: null, chargesAccrued: 6000, chargesOutstanding: 0 })
  Object.assign(loan.repaymentSchedule[0], { installmentNo: 1, totalPaid: 0, status: "PAID", paidAt: null, creditLifePremiumDue: 0 })
  const syncTx = { ...tx,
    loan: { ...tx.loan, update: vi.fn().mockResolvedValue({}) },
    loanCharge: { ...tx.loanCharge, deleteMany: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
    payment: { ...tx.payment, update: vi.fn().mockResolvedValue({}) },
    repaymentSchedule: { update: vi.fn().mockResolvedValue({}) }, auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  const result = await syncLoanCharges(syncTx as never, { tenantId: "tenant", loanId: "lease" }, d("2026-09-25"), { source: "assessed_lease_cancellation" }, { mode: "reversal" })
  expect(result).toMatchObject({ chargesOutstanding: 15_000, chargesAccrued: 31_000 })
  expect(syncTx.loanCharge.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { tenantId: "tenant", loanId: "lease", type: "RECOVERY_COST", sourceId: { in: ["new-certified"] } } })
  expect(syncTx.loanCharge.createMany.mock.calls[0][0].data).toEqual([{ tenantId: "tenant", loanId: "lease", type: "RECOVERY_COST", day: new Date("2026-09-21"), amount: 25_000, sourceId: "new-certified" }])
  expect(syncTx.payment.update).toHaveBeenCalledExactlyOnceWith({ where: { id: "actual-sale-proceeds", tenantId: "tenant" }, data: { defaultInterestAllocated: 0, chargeFeesAllocated: 10_000 } })
})
