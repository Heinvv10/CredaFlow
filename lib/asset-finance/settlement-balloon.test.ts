import { describe, expect, it } from "vitest"
import { currentSettlementAmount, projectReceipt } from "@/lib/loan/settlement"
import { planBooking } from "./booking-plan"
import { solveStructure } from "./structure"
import type { StructureInput } from "./types"

// The settlement quote on an asset-finance loan with a balloon (goal §4.11).
// The balloon is stored as principal on the LAST schedule row
// (./schedule-records.ts), so the quote carries it through the schedule
// totals: settlementDue = totalRepayable − totalPaid (+ charges owed).
//
// What the quote is, exactly, for a REDUCING_BALANCE loan (lib/loan/
// settlement.ts settlementTerms): every remaining scheduled amount, i.e. the
// remaining principal INCLUDING the balloon PLUS all remaining scheduled
// interest, plus default charges owed. Unearned future interest is NOT
// rebated: only a single-row DAILY_ACCRUAL loan gets an accrued-to-date quote.
// The last test pins that, so moving NON_NCA to "principal + accrued interest"
// is a visible, deliberate change.

// Synthetic: R1 725 000 incl. VAT, R172 500 deposit, R200 000 balloon,
// 36 months at 11.75%, first due two months after the start.
const DEAL: StructureInput = {
  cashPriceCents: 172_500_000,
  depositCents: 17_250_000,
  tradeInCents: 0,
  financedFeesCents: 0,
  balloonCents: 20_000_000,
  weights: new Array(36).fill(1),
  startDate: "2026-10-13",
  firstDueDate: "2026-12-13",
  ratePath: [{ effectiveDate: "2026-10-13", annualRate: 0.1175 }],
}

function bookedLoan(paidInstalments: number) {
  const result = solveStructure(DEAL)
  const plan = planBooking({ result, startDate: DEAL.startDate, balloonCents: DEAL.balloonCents, payoutCents: 155_250_000 })
  const rows = plan.records.map((r, i) => ({ ...r, id: `row-${i + 1}`, totalPaid: i < paidInstalments ? r.totalDue : 0 }))
  const totalPaid = rows.reduce((t, r) => t + r.totalPaid, 0)
  const loan = {
    principal: plan.principal,
    totalInterest: plan.totalInterest,
    totalRepayable: plan.totalRepayable,
    totalPaid,
    interestRatePm: 0.1175 / 12,
    interestModel: "REDUCING_BALANCE" as const,
    startDate: plan.startDate,
    maturityDate: plan.maturityDate,
  }
  return { loan, rows, plan, result }
}

const asOf = new Date("2027-04-01T10:00:00+02:00")
const sum = (values: number[]) => values.reduce((t, v) => t + v, 0)

describe("settlement quote on a balloon loan", () => {
  it("includes the balloon: the remaining principal it sums carries the last row's balloon", () => {
    const { loan, rows } = bookedLoan(4)
    const quote = currentSettlementAmount({ loan, schedule: rows, asOf })
    const remaining = rows.slice(4)
    expect(remaining.at(-1)?.principalDue).toBeGreaterThan(DEAL.balloonCents)
    expect(quote).toBe(sum(remaining.map((r) => r.totalDue)))
    expect(quote).toBe(sum(remaining.map((r) => r.principalDue)) + sum(remaining.map((r) => r.interestDue)))
    expect(quote).toBeGreaterThan(DEAL.balloonCents + sum(remaining.slice(0, -1).map((r) => r.principalDue)))
  })

  it("adds default charges owed on top", () => {
    const { loan, rows } = bookedLoan(4)
    const without = currentSettlementAmount({ loan, schedule: rows, asOf })
    expect(currentSettlementAmount({ loan, schedule: rows, asOf, chargesOutstanding: 31_000 })).toBe(without + 31_000)
  })

  it("before any payment it is the whole schedule: financed amount + all interest", () => {
    const { loan, rows, result } = bookedLoan(0)
    expect(currentSettlementAmount({ loan, schedule: rows, asOf: new Date("2026-11-01T10:00:00+02:00") }))
      .toBe(result.financedAmountCents + result.totalInterestCents)
  })

  it("a receipt of exactly the quote settles the loan, balloon row included, with nothing refund-due", () => {
    const { loan, rows } = bookedLoan(4)
    const quote = currentSettlementAmount({ loan, schedule: rows, asOf, chargesOutstanding: 31_000 })
    const projection = projectReceipt({ loan, schedule: rows, amount: quote, asOf, chargesOutstanding: 31_000 })
    expect(projection.isCompleted).toBe(true)
    expect(projection.excessAmount).toBe(0)
    expect(projection.chargesAllocated).toBe(31_000)
    expect(projection.rows.every((r) => r.totalPaid === r.totalDue)).toBe(true)
  })

  it("PINNED: future scheduled interest is in the quote (no rebate to accrued-to-date on a NON_NCA loan)", () => {
    const { loan, rows } = bookedLoan(4)
    const quote = currentSettlementAmount({ loan, schedule: rows, asOf })
    const remainingPrincipal = sum(rows.slice(4).map((r) => r.principalDue))
    // Interest accrued since the last paid due date (13 Mar → 1 Apr) at most
    // one month's interest on the balance; the quote carries far more.
    const oneMonthInterest = Math.round(remainingPrincipal * 0.1175 / 12)
    expect(quote - remainingPrincipal).toBeGreaterThan(10 * oneMonthInterest)
  })
})
