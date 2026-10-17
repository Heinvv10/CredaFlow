import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"

// Spies that still run the real engines, so both the dispatch and the posted
// result are checked.
const engines = vi.hoisted(() => ({ nca: vi.fn(), nonNca: vi.fn() }))
vi.mock("@/lib/loan/default-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/loan/default-charges")>()
  engines.nca.mockImplementation(actual.computeDefaultCharges)
  return { ...actual, computeDefaultCharges: engines.nca }
})
vi.mock("@/lib/asset-finance/non-nca-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/asset-finance/non-nca-charges")>()
  engines.nonNca.mockImplementation(actual.computeNonNcaCharges)
  return { ...actual, computeNonNcaCharges: engines.nonNca }
})

import { syncLoanCharges } from "./charges-sync"
import { loadChargesReplay } from "./charges-replay"

// Midday SAST so a date never straddles the SAST/UTC day boundary.
const d = (ymd: string) => new Date(`${ymd}T12:00:00+02:00`)
const ref = { tenantId: "t1", loanId: "loan-1" }

// R2,000 bullet + R100 interest + R69 fee due 1 Sep, unpaid; a Section 129
// letter on record. Synced on 11 Sep: Sep 2..10 are complete days in default.
function makeLoan(ncaRegime: "NCA" | "NON_NCA") {
  return {
    principal: 200_000, interestRatePm: 0.05, ncaRegime, maturityDate: d("2026-09-01"),
    status: "ACTIVE", closedAt: null, writeOffAt: null, totalPaid: 0, outstandingPrincipal: 200_000,
    arrearsAmount: 216_900, daysInArrears: 10, nextPaymentDate: d("2026-09-01"),
    chargesAccrued: 0, chargesOutstanding: 0, defaultChargesExempt: false, defaultChargesExemptReason: null,
    defaultChargesExemptEndedAt: null as Date | null, monthlyServiceFee: 6_900,
    // The agreement's terms, copied from the deal's signed terms at booking.
    // The product has since been edited: the replay must not read it.
    nonNcaDefaultInterestMargin: new Prisma.Decimal("0.02") as Prisma.Decimal | null,
    nonNcaCollectionFeeCents: 25_000 as number | null,
    product: {
      code: "AF", monthlyServiceFee: 6_900,
      nonNcaDefaultInterestMargin: new Prisma.Decimal("0.09"), nonNcaCollectionFeeCents: 99_000,
    },
    application: { affordabilityResult: null },
    contractRates: [] as Array<{ effectiveDate: Date; resultingRate: Prisma.Decimal }>,
    tenant: {
      config: {
        defaultChargesEnabled: true, defaultAdminChargeCents: 8_200, defaultAdminPostageCents: 1_500,
        defaultChargesStartedAt: d("2026-01-01"), defaultChargesStoppedAt: null,
      },
    },
    repaymentSchedule: [{
      id: "row-1", dueDate: d("2026-09-01"), principalDue: 200_000, interestDue: 10_000, feesDue: 6_900,
      creditLifePremiumDue: 0, totalDue: 216_900, totalPaid: 0, status: "PENDING", paidAt: null,
    }],
  }
}

function makeTx(loan: ReturnType<typeof makeLoan>) {
  return {
    loan: { findUnique: vi.fn().mockResolvedValue(loan), update: vi.fn().mockResolvedValue({}) },
    payment: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    complianceRecord: {
      findMany: vi.fn().mockResolvedValue([
        { id: "s129-1", completedAt: d("2026-09-05"), data: { lifecycle: "ISSUED", adminChargeCents: 9_700 } },
      ]),
    },
    loanCharge: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    repaymentSchedule: { update: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
}

it("preserves historical NON_NCA charges and live-era receipt splits after the permanent stop", async () => {
  const loan = makeLoan("NON_NCA")
  Object.assign(loan.tenant.config, { defaultChargesEnabled: false, defaultChargesStoppedAt: d("2026-09-20") })
  const tx = makeTx(loan)
  tx.loanCharge.findMany.mockResolvedValue([{ type: "DEFAULT_INTEREST", day: d("2026-09-10"), amount: 1000, sourceId: null }] as never)
  tx.payment.findMany.mockResolvedValue([{ id: "live-era-receipt", amount: 5000, receivedAt: d("2026-09-10"), defaultInterestAllocated: 1000, chargeFeesAllocated: 0 }] as never)
  // The permanent stop leaves stored charge history and paid splits unchanged.
  const result = await syncLoanCharges(tx as never, ref, d("2026-09-26"), { source: "test" })
  expect(result).toMatchObject({ totalPaid: 4000, chargesAccrued: 1000, chargesOutstanding: 0 })
  expect.soft(tx.loanCharge.deleteMany).not.toHaveBeenCalled()
  expect.soft(tx.payment.update).not.toHaveBeenCalled()
})

async function sync(ncaRegime: "NCA" | "NON_NCA") {
  engines.nca.mockClear()
  engines.nonNca.mockClear()
  const tx = makeTx(makeLoan(ncaRegime))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await syncLoanCharges(tx as any, ref, d("2026-09-11"), { source: "test" })
  const posted = tx.loanCharge.createMany.mock.calls[0]?.[0].data as Array<{ type: string; day: Date; amount: number }>
  return { result, posted: posted.map((c) => ({ type: c.type, day: c.day.toISOString().slice(0, 10), amount: c.amount })) }
}

it("does not resurrect contractual interest blocked before the permanent stop", async () => {
  const loan = makeLoan("NON_NCA")
  Object.assign(loan, { startDate: d("2019-01-01"), principal: 10000, interestRatePm: 1,
    maturityDate: d("2021-01-01"), nonNcaDefaultInterestMargin: new Prisma.Decimal(0), nonNcaCollectionFeeCents: null })
  Object.assign(loan.tenant.config, { defaultChargesStartedAt: d("2019-01-01") })
  loan.repaymentSchedule = ["2020-01-01", "2021-01-01"].map((date, i) => ({ id: `row-${i}`, dueDate: d(date), principalDue: 5000, interestDue: 1000, feesDue: 0, creditLifePremiumDue: 0, totalDue: 6000, totalPaid: 0, status: "PENDING", paidAt: null }))
  const tx = makeTx(loan)
  const before = await loadChargesReplay(tx as never, ref, d("2022-01-01"))
  const lawful = before!.result.lawfulSchedule!
  expect(lawful[1].interestDue).toBeLessThan(1000)
  loan.repaymentSchedule.forEach((row, i) => Object.assign(row, { interestDue: lawful[i].interestDue, totalDue: lawful[i].totalDue, commonLawContractualInterestDue: lawful[i].contractualInterestDue }))
  tx.loanCharge.findMany.mockResolvedValue(before!.result.postings.map((row) => ({ ...row, day: d(row.day), sourceId: null })) as never)
  Object.assign(loan.tenant.config, { defaultChargesEnabled: false, defaultChargesStoppedAt: d("2022-01-01") })
  const after = await loadChargesReplay(tx as never, ref, d("2022-01-02"))
  expect(after!.result.lawfulSchedule![1].interestDue).toBe(lawful[1].interestDue)
})

describe("syncLoanCharges dispatches by Loan.ncaRegime", () => {
  it("an NCA loan runs the NCA engine: default interest at the monthly rate and the s129 letter charge", async () => {
    const { result, posted } = await sync("NCA")
    expect(engines.nca).toHaveBeenCalled()
    expect(engines.nonNca).not.toHaveBeenCalled()
    // 9 x 200000 x 5% / 30 = 3000; the letter's frozen R97.
    expect(posted).toEqual([
      { type: "DEFAULT_ADMIN", day: "2026-09-05", amount: 9_700 },
      { type: "DEFAULT_INTEREST", day: "2026-09-10", amount: 3_000 },
    ])
    expect(result?.chargesAccrued).toBe(12_700)
  })

  it("a NON_NCA loan runs the NON_NCA engine: the loan's booked margin and collection fee (not the edited product's), no letter charge", async () => {
    const { result, posted } = await sync("NON_NCA")
    expect(engines.nonNca).toHaveBeenCalled()
    expect(engines.nca).not.toHaveBeenCalled()
    expect(engines.nonNca.mock.calls[0][0]).toMatchObject({ defaultInterestMargin: 0.02, collectionFeeCents: 25_000 })
    // (60% + 2%) / 365 on R2,100 overdue (principal + contractual interest)
    // for 9 days: 9 x 210000 x 0.62/365 = 3210.41 → 3210.
    expect(posted).toEqual([
      { type: "COLLECTION_FEE", day: "2026-09-02", amount: 25_000 },
      { type: "DEFAULT_INTEREST", day: "2026-09-10", amount: 3_210 },
    ])
    expect(result?.chargesAccrued).toBe(28_210)
  })

  it("a NON_NCA replay follows the loan's effective-dated ContractRate history", async () => {
    const loan = makeLoan("NON_NCA")
    loan.nonNcaDefaultInterestMargin = new Prisma.Decimal(0)
    loan.nonNcaCollectionFeeCents = null
    loan.contractRates = [
      { effectiveDate: d("2026-01-01"), resultingRate: new Prisma.Decimal("0.12") },
      { effectiveDate: d("2026-09-06"), resultingRate: new Prisma.Decimal("0.24") },
    ]
    const tx = makeTx(loan)
    const result = await syncLoanCharges(tx as unknown as Parameters<typeof syncLoanCharges>[0], ref, d("2026-09-11"), { source: "test" })
    expect(engines.nonNca.mock.calls.at(-1)?.[0].contractRateHistory).toEqual([
      { effectiveDate: d("2026-01-01"), annualRate: 0.12 },
      { effectiveDate: d("2026-09-06"), annualRate: 0.24 },
    ])
    // Sep 2..5 at 12%, Sep 6..10 at 24%, on R2,100 overdue.
    expect(result?.chargesAccrued).toBe(967)
  })

  it("a NON_NCA loan whose accrueFrom is after the missed due date: no collection fee, interest only from accrueFrom", async () => {
    const loan = makeLoan("NON_NCA")
    // An exemption lifted on 5 Sep, after the instalment fell due on 1 Sep:
    // charging resumes from that moment (charges-replay accrueFromWith).
    const lifted = d("2026-09-05")
    loan.defaultChargesExemptEndedAt = lifted
    const tx = makeTx(loan)
    const result = await syncLoanCharges(tx as unknown as Parameters<typeof syncLoanCharges>[0], ref, d("2026-09-11"), { source: "test" })
    expect(engines.nonNca.mock.calls.at(-1)?.[0].accrueFrom).toEqual(lifted)
    const posted = (tx.loanCharge.createMany.mock.calls[0]?.[0].data as Array<{ type: string; day: Date; amount: number }>)
      .map((c) => ({ type: c.type, day: c.day.toISOString().slice(0, 10), amount: c.amount }))
    // The collection fee for the 1 Sep instalment would be dated 2 Sep, before
    // accrueFrom, so it is never posted. Default interest for Sep 5..10 only:
    // 6 x 210000 x 0.62/365 = 2140.27 → 2140.
    expect(posted).toEqual([{ type: "DEFAULT_INTEREST", day: "2026-09-10", amount: 2_140 }])
    expect(result?.chargesAccrued).toBe(2_140)
  })

  it("a NON_NCA loan with no terms on it charges nothing: the product's terms are never read", async () => {
    const loan = makeLoan("NON_NCA")
    loan.nonNcaDefaultInterestMargin = null
    loan.nonNcaCollectionFeeCents = null
    const tx = makeTx(loan)
    await syncLoanCharges(tx as unknown as Parameters<typeof syncLoanCharges>[0], ref, d("2026-09-11"), { source: "test" })
    expect(engines.nonNca.mock.calls.at(-1)?.[0]).toMatchObject({ defaultInterestMargin: null, collectionFeeCents: null })
  })

  it("a NON_NCA loan with only one term booked keeps the other null rather than borrowing the product's", async () => {
    const loan = makeLoan("NON_NCA")
    loan.nonNcaDefaultInterestMargin = null
    const tx = makeTx(loan)
    await syncLoanCharges(tx as unknown as Parameters<typeof syncLoanCharges>[0], ref, d("2026-09-11"), { source: "test" })
    expect(engines.nonNca.mock.calls.at(-1)?.[0]).toMatchObject({ defaultInterestMargin: null, collectionFeeCents: 25_000 })
  })

  it("the tenant's charges switch gates NON_NCA charges too: off means no charges at all", async () => {
    const loan = makeLoan("NON_NCA")
    loan.tenant.config.defaultChargesEnabled = false
    const tx = makeTx(loan)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await syncLoanCharges(tx as any, ref, d("2026-09-11"), { source: "test" })).toMatchObject({ chargesAccrued: 0, chargesOutstanding: 0 })
    expect(tx.loanCharge.createMany).not.toHaveBeenCalled()
    // Contractual interest remains subject to common-law replay while optional charges are off.
  })
})
