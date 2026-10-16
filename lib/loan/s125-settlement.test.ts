import { describe, expect, it } from "vitest"
import { calculateLoan } from "@/lib/loan-calculator"
import { s125InstalmentSettlement } from "./s125-settlement"
import {
  backdatingInterestRebate,
  currentSettlementAmount,
  projectReceipt,
  receiptContractualTotalsUpdate,
  settlementAuditEvidence,
} from "./settlement"

// Elize's loan from the Fair Score audit (2026-10-16), rebuilt: R34,000 Personal
// Loan at 3% a month reducing, 18 months from 17 April 2026, R1,080 initiation
// fee deferred into instalment 1, R69 service fee. Instalment R2,541.10.
// R12,942.20 paid: instalments 1–4 and R1,697.80 of instalment 5 (due
// 17 September), so R843.30 is in arrears. Outstanding principal R27,133.91;
// the old settlement figure R33,877.51 (everything still scheduled).
const start = new Date("2026-04-17T10:00:00+02:00")
const calc = calculateLoan({
  principal: 3_400_000, termDays: 540, interestRatePm: 0.03, productType: "PERSONAL", interestModel: "REDUCING_BALANCE",
  initiationFeeModel: "NCA_REG42", initiationFeePct: 0.165, initiationFeeMax: 108_000, monthlyServiceFee: 6_900,
}, start)
const PAID = 1_294_220
const loan = { startDate: start, totalPaid: PAID, initiationFee: calc.initiationFee, monthlyServiceFee: 6_900 }
const settleOn = (iso: string) => s125InstalmentSettlement(loan, calc.schedule, new Date(iso))

describe("s125 settlement of an instalment agreement (Elize's loan)", () => {
  it("rebuilds the audited loan", () => {
    expect(calc.monthlyInstalment).toBe(254_110)
    expect(calc.totalRepayable - PAID).toBe(3_387_751) // R33,877.51, the figure staff and the portal showed
    expect(calc.schedule[5]).toMatchObject({ principalDue: 168_338, interestDue: 78_872, feesDue: 6_900 })
    expect(calc.schedule[5].closingBalance).toBe(2_460_723)
  })

  it("settles on 16 October at the principal owed plus 29 of 30 days' interest: R27,896.34", () => {
    // Instalments 1–5 fully earned:                  R13,785.50
    // Instalment 6: principal R1,683.38 + R788.72 x 29/30 = R762.43
    // Instalments 7–18: principal only               R24,607.23
    // Earned R40,838.54 − paid R12,942.20            = R27,896.34
    //   = outstanding principal R27,133.91 + accrued interest R762.43.
    const result = settleOn("2026-10-16T10:00:00+02:00")
    expect(result.accruedInterest).toBe(76_243)
    expect(result.settlementDue).toBe(2_789_634)
    expect(result.settlementDue).toBe(2_713_391 + 76_243)
    // Not charged: the rest of the scheduled interest and every later service fee.
    expect(result.rebate).toBe(3_387_751 - 2_789_634)
  })

  it("charges the whole instalment once its due date arrives", () => {
    // 17 October: instalment 6 is due in full (its R69 fee and R788.72 interest).
    expect(settleOn("2026-10-17T10:00:00+02:00").settlementDue).toBe(1_378_550 + 254_110 + 2_460_723 - PAID)
  })

  it("keeps a deferred initiation fee payable before instalment 1 falls due", () => {
    // Settled the day after payout: principal + 1 day's interest + the R1,080
    // initiation fee, no service fee and none of the 18 months' interest.
    const fresh = { ...loan, totalPaid: 0 }
    const result = s125InstalmentSettlement(fresh, calc.schedule, new Date("2026-04-18T10:00:00+02:00"))
    expect(result.accruedInterest).toBe(Math.round(102_000 / 30))
    expect(result.settlementDue).toBe(3_400_000 + Math.round(102_000 / 30) + 108_000)
  })

  it("credits money prepaid on future instalments", () => {
    const prepaid = { ...loan, totalPaid: PAID + 84_330 + 100_000 }
    expect(s125InstalmentSettlement(prepaid, calc.schedule, new Date("2026-10-16T10:00:00+02:00")).settlementDue)
      .toBe(2_789_634 - 84_330 - 100_000)
  })

  it("owes nothing once every instalment is paid", () => {
    const paidUp = { ...loan, totalPaid: calc.totalRepayable }
    expect(s125InstalmentSettlement(paidUp, calc.schedule, new Date("2027-12-01T10:00:00+02:00")).settlementDue).toBe(0)
  })
})

describe("the receipt path settles at the s125 figure (lib/loan/settlement.ts)", () => {
  const rows = calc.schedule.map((row, i) => ({
    ...row, id: `row-${i + 1}`, creditLifePremiumDue: 0,
    totalPaid: Math.max(0, Math.min(row.totalDue, PAID - calc.schedule.slice(0, i).reduce((s, r) => s + r.totalDue, 0))),
  }))
  const elize = {
    id: "loan-elize", principal: 3_400_000, totalInterest: calc.totalInterest, totalRepayable: calc.totalRepayable,
    contractualTotalInterest: null, contractualTotalRepayable: null, totalPaid: PAID, interestRatePm: 0.03,
    interestModel: "REDUCING_BALANCE" as const, startDate: start, maturityDate: calc.schedule.at(-1)!.dueDate,
    ncaRegime: "NCA", contractType: "LOAN", initiationFee: calc.initiationFee, monthlyServiceFee: 6_900,
  }
  const asOf = new Date("2026-10-16T10:00:00+02:00")

  it("states R27,896.34 as the settlement, not R33,877.51", () => {
    expect(currentSettlementAmount({ loan: elize, schedule: rows, asOf })).toBe(2_789_634)
  })

  it("keeps the contractual figure for an agreement s125 does not cover here (asset finance, NON_NCA)", () => {
    expect(currentSettlementAmount({ loan: { ...elize, ncaRegime: "NON_NCA" }, schedule: rows, asOf })).toBe(3_387_751)
    expect(currentSettlementAmount({ loan: { ...elize, contractType: "INSTALMENT_SALE" }, schedule: rows, asOf })).toBe(3_387_751)
  })

  it("closes the loan on a receipt of exactly that figure, re-pricing the rows and recording the contract", () => {
    const projection = projectReceipt({ loan: elize, schedule: rows, amount: 2_789_634, asOf })
    expect(projection).toMatchObject({
      isCompleted: true, isEarlyInstalmentSettlement: true, isEarlyDailySettlement: false, loanId: "loan-elize",
      newTotalPaid: PAID + 2_789_634, totalRepayable: PAID + 2_789_634,
      contractualTotalRepayable: calc.totalRepayable, contractualTotalInterest: calc.totalInterest,
    })
    // Rows 1–5 unchanged; row 6 principal + 29/30 of its interest; rows 7–18 principal only.
    expect(projection.rows[4]).toMatchObject({ interestDue: 83_775, feesDue: 6_900, totalDue: 254_110 })
    expect(projection.rows[5]).toMatchObject({ interestDue: 76_243, feesDue: 0, creditLifePremiumDue: 0, totalDue: 168_338 + 76_243 })
    expect(projection.rows[6]).toMatchObject({ interestDue: 0, feesDue: 0, totalDue: calc.schedule[6].principalDue })
    expect(projection.rows.every((row) => row.totalPaid === row.totalDue)).toBe(true)
    expect(projection.totalInterest).toBe(projection.rows.reduce((sum, row) => sum + row.interestDue, 0))
    expect(projection.interestRebate + projection.feesRebate).toBe(3_387_751 - 2_789_634)
    expect(projection.feesRebate).toBe(13 * 6_900)
    expect(projection.contractualRows?.[5]).toEqual({
      id: "row-6", installmentNo: 6, principalDue: 168_338, interestDue: 78_872, feesDue: 6_900, creditLifePremiumDue: 0, totalDue: 254_110,
    })
    expect(settlementAuditEvidence(projection)).toMatchObject({
      earlyInstalmentSettlement: true, loanId: "loan-elize", settlementDue: 2_789_634,
      resultingTotalRepayable: PAID + 2_789_634, contractualTotalRepayable: calc.totalRepayable,
    })
    expect(receiptContractualTotalsUpdate(projection)).toEqual({
      contractualTotalInterest: calc.totalInterest, contractualTotalRepayable: calc.totalRepayable,
    })
  })

  it("re-prices nothing on a receipt below the figure", () => {
    const projection = projectReceipt({ loan: elize, schedule: rows, amount: 254_110, asOf })
    expect(projection).toMatchObject({ isCompleted: false, isEarlyInstalmentSettlement: false, contractualRows: null })
    expect(projection.rows.map((row) => row.totalDue)).toEqual(rows.map((row) => row.totalDue))
    expect(receiptContractualTotalsUpdate(projection)).toEqual({})
  })

  it("measures back-dating only on a receipt that settles", () => {
    const tenDaysBack = new Date("2026-10-06T10:00:00+02:00")
    expect(backdatingInterestRebate({ loan: elize, schedule: rows, asOf, receivedAt: tenDaysBack, amount: 254_110 }).rebateCents).toBe(0)
    // 10 of the 30 days' interest on R27,133.91 = R262.91.
    expect(backdatingInterestRebate({ loan: elize, schedule: rows, asOf, receivedAt: tenDaysBack, amount: 2_789_634 }).rebateCents)
      .toBe(76_243 - Math.round((78_872 * 19) / 30))
  })
})
