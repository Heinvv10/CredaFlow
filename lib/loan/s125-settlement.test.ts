import { describe, expect, it } from "vitest"
import { calculateLoan } from "@/lib/loan-calculator"
import { s125InstalmentSettlement } from "./s125-settlement"

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
