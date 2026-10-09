import { describe, expect, it } from "vitest"
import {
  currentSettlementAmount,
  projectReceipt,
  receiptContractualTotalsUpdate,
  restoreContractualBulletSchedule,
} from "./settlement"

const startDate = new Date("2026-07-01T08:00:00.000Z")
const maturityDate = new Date("2026-07-31T08:00:00.000Z")
const schedule = [{
  id: "row-1",
  dueDate: maturityDate,
  principalDue: 200_000,
  interestDue: 10_000,
  feesDue: 36_900,
  totalDue: 246_900,
  totalPaid: 0,
}]
const loan = {
  principal: 200_000,
  totalInterest: 10_000,
  totalRepayable: 246_900,
  contractualTotalInterest: null,
  contractualTotalRepayable: null,
  totalPaid: 0,
  interestRatePm: 0.05,
  interestModel: "DAILY_ACCRUAL" as const,
  startDate,
  maturityDate,
}

describe("daily-accrual settlement projection", () => {
  it("quotes the same day-15 amount shown in the payment UI", () => {
    expect(currentSettlementAmount({
      loan,
      schedule,
      asOf: new Date("2026-07-16T10:00:00.000Z"),
    })).toBe(241_900)
  })

  it("charges only 15 elapsed days of interest on a day-15 settlement", () => {
    const result = projectReceipt({
      loan,
      schedule,
      amount: 241_900,
      asOf: new Date("2026-07-16T10:00:00.000Z"),
    })

    expect(result).toMatchObject({
      settlementDue: 241_900,
      isCompleted: true,
      isEarlyDailySettlement: true,
      accruedInterest: 5_000,
      interestRebate: 5_000,
      totalInterest: 5_000,
      totalRepayable: 241_900,
      contractualTotalInterest: 10_000,
      contractualTotalRepayable: 246_900,
    })
    expect(result.rows[0]).toMatchObject({
      interestDue: 5_000,
      totalDue: 241_900,
      totalPaid: 241_900,
    })
  })

  it("captures the pre-rebate contract on the receipt that reprices it", () => {
    const result = projectReceipt({
      loan,
      schedule,
      amount: 241_900,
      asOf: new Date("2026-07-16T10:00:00.000Z"),
    })

    // This receipt drops totalRepayable to 241_900. If the 246_900 contract is
    // not recorded here there is nothing left to audit the rebate against.
    expect(receiptContractualTotalsUpdate(result)).toEqual({
      contractualTotalInterest: 10_000,
      contractualTotalRepayable: 246_900,
    })
    expect(result.totalRepayable).not.toBe(246_900)
  })

  it("leaves the booked contract alone on an ordinary receipt", () => {
    const result = projectReceipt({
      loan,
      schedule,
      amount: 100_000,
      asOf: new Date("2026-07-16T10:00:00.000Z"),
    })

    expect(result.isEarlyDailySettlement).toBe(false)
    // Not "writes the same value" - writes NOTHING. Spreading an empty object
    // is what keeps the columns out of the Prisma update entirely.
    expect(receiptContractualTotalsUpdate(result)).toEqual({})
    expect(Object.keys(receiptContractualTotalsUpdate(result))).toHaveLength(0)
  })

  it("rejects collection of the unearned maturity interest", () => {
    expect(() => projectReceipt({
      loan,
      schedule,
      amount: 246_900,
      asOf: new Date("2026-07-16T10:00:00.000Z"),
    })).toThrow("Receipt exceeds settlement amount:241900")
  })

  it("still rejects an over-settlement receipt unless the caller opts in", () => {
    // The guard is the default. Only a caller that has somewhere to PUT the
    // excess (a refund-due receipt) may switch it off.
    expect(() => projectReceipt({
      loan,
      schedule,
      amount: 250_000,
      asOf: new Date("2026-07-18T10:00:00.000Z"),
    })).toThrow("Receipt exceeds settlement amount:242567")
  })

  it("splits a receipt that exceeds settlement into applied + excess", () => {
    // The live case: R2,469.00 maturity total, settled on day 17, client paid
    // R2,500.00. s125(2)(b) charges 17/30 days of interest (R56.67), so the
    // lawful settlement is R2,425.67 and R74.33 must go back to the client.
    const result = projectReceipt({
      loan,
      schedule,
      amount: 250_000,
      asOf: new Date("2026-07-18T10:00:00.000Z"),
      allowOverpayment: true,
    })

    expect(result).toMatchObject({
      settlementDue: 242_567,
      appliedAmount: 242_567,
      excessAmount: 7_433,
      isCompleted: true,
      isEarlyDailySettlement: true,
      accruedInterest: 5_667,
      interestRebate: 4_333,
      totalRepayable: 242_567,
    })
  })

  it("keeps the excess out of totalPaid and off the schedule", () => {
    // The excess is money held for the client, NOT a repayment. If it leaks
    // into newTotalPaid the loan over-reports what was collected and every
    // downstream legal document (statement, certificate of balance) inherits it.
    const result = projectReceipt({
      loan,
      schedule,
      amount: 250_000,
      asOf: new Date("2026-07-18T10:00:00.000Z"),
      allowOverpayment: true,
    })

    expect(result.newTotalPaid).toBe(242_567)
    expect(result.newTotalPaid).not.toBe(250_000)
    expect(result.rows[0].totalPaid).toBe(242_567)
  })

  it("reports no excess when an opted-in receipt is within settlement", () => {
    const result = projectReceipt({
      loan,
      schedule,
      amount: 100_000,
      asOf: new Date("2026-07-18T10:00:00.000Z"),
      allowOverpayment: true,
    })

    expect(result).toMatchObject({
      appliedAmount: 100_000,
      excessAmount: 0,
      isCompleted: false,
      newTotalPaid: 100_000,
    })
  })

  it("treats the whole receipt as excess once nothing is owed", () => {
    // A fully-paid loan owes 0, so there is no allocated portion to book —
    // every cent is refund-due. Guards against creating a R0.00 receipt.
    const settledLoan = { ...loan, totalPaid: 242_567 }
    const result = projectReceipt({
      loan: settledLoan,
      schedule: [{ ...schedule[0], totalPaid: 242_567 }],
      amount: 50_000,
      asOf: new Date("2026-07-18T10:00:00.000Z"),
      allowOverpayment: true,
    })

    expect(result).toMatchObject({
      settlementDue: 0,
      appliedAmount: 0,
      excessAmount: 50_000,
      newTotalPaid: 242_567,
    })
  })

  it("retains the full contractual amount at maturity", () => {
    const result = projectReceipt({
      loan,
      schedule,
      amount: 246_900,
      asOf: maturityDate,
    })
    expect(result).toMatchObject({
      settlementDue: 246_900,
      isCompleted: true,
      isEarlyDailySettlement: false,
      totalInterest: 10_000,
      totalRepayable: 246_900,
    })
  })

  it("restores the original bullet schedule after reversing an early settlement", () => {
    const adjustedLoan = {
      ...loan,
      totalInterest: 5_000,
      totalRepayable: 241_900,
      contractualTotalInterest: 10_000,
      contractualTotalRepayable: 246_900,
      totalPaid: 241_900,
    }
    const restored = restoreContractualBulletSchedule({
      loan: adjustedLoan,
      schedule: [{
        ...schedule[0],
        interestDue: 5_000,
        totalDue: 241_900,
        totalPaid: 241_900,
      }],
    })
    expect(restored[0]).toMatchObject({
      interestDue: 10_000,
      totalDue: 246_900,
    })
  })

  it("leaves a never-repriced schedule alone when no contract was ever captured", () => {
    // Gating the contractual write means legacy loans now stay NULL through
    // ordinary receipts instead of being backfilled by the first one. A later
    // reversal then reaches the `contractualTotalRepayable == null` branch,
    // which the route-level test mocks away entirely. NULL is only reachable
    // when nothing ever repriced, so the schedule already IS the contract and
    // must come back untouched — restoring toward `?? totalRepayable` here
    // would overwrite live figures with post-payment ones.
    const legacyLoan = {
      ...loan,
      contractualTotalInterest: null,
      contractualTotalRepayable: null,
      totalPaid: 100_000,
    }
    const untouched = {
      ...schedule[0],
      interestDue: 10_000,
      totalDue: 246_900,
      totalPaid: 100_000,
    }

    expect(restoreContractualBulletSchedule({
      loan: legacyLoan,
      schedule: [untouched],
    })[0]).toEqual(untouched)
  })
})

describe("settlement with default charges outstanding", () => {
  // After maturity, so no early-settlement repricing is in play.
  const asOf = new Date("2026-08-20T10:00:00.000Z")

  it("adds charges outstanding at the value date to the settlement amount", () => {
    expect(currentSettlementAmount({
      loan, schedule, asOf, chargesOutstanding: 4_000,
    })).toBe(246_900 + 4_000)
  })

  it("accepts a receipt that pays only charges, leaving the schedule untouched", () => {
    const paidUp = { ...loan, totalPaid: 246_900 }
    const paidRows = [{ ...schedule[0], totalPaid: 246_900 }]
    const result = projectReceipt({
      loan: paidUp, schedule: paidRows, amount: 4_000, asOf, chargesOutstanding: 4_000,
    })
    expect(result).toMatchObject({
      settlementDue: 4_000,
      appliedAmount: 4_000,
      excessAmount: 0,
      chargesAllocated: 4_000,
      newTotalPaid: 246_900,
      isCompleted: true,
    })
    expect(result.rows[0].totalPaid).toBe(246_900)
  })

  it("pays charges before the schedule and completes only when both are covered", () => {
    const partial = projectReceipt({
      loan, schedule, amount: 246_900, asOf, chargesOutstanding: 4_000,
    })
    expect(partial).toMatchObject({
      chargesAllocated: 4_000,
      newTotalPaid: 242_900,
      isCompleted: false,
    })

    const full = projectReceipt({
      loan, schedule, amount: 250_900, asOf, chargesOutstanding: 4_000,
    })
    expect(full).toMatchObject({ newTotalPaid: 246_900, isCompleted: true })
  })

  it("splits only money beyond charges plus schedule off as excess", () => {
    const result = projectReceipt({
      loan, schedule, amount: 260_000, asOf, chargesOutstanding: 4_000, allowOverpayment: true,
    })
    expect(result).toMatchObject({
      appliedAmount: 250_900,
      excessAmount: 9_100,
      chargesAllocated: 4_000,
      newTotalPaid: 246_900,
    })
  })

  it("rejects over-settlement at the charge-inclusive amount", () => {
    expect(() => projectReceipt({
      loan, schedule, amount: 250_901, asOf, chargesOutstanding: 4_000,
    })).toThrow("Receipt exceeds settlement amount:250900")
  })
})

describe("settlement capped by the default-charges replay", () => {
  const asOf = new Date("2026-08-20T10:00:00.000Z")

  it("never applies more than the replay says is owed, splitting the rest off as excess", () => {
    const result = projectReceipt({
      loan, schedule, amount: 246_900, asOf, allowOverpayment: true, replayCapCents: 240_000,
    })
    expect(result).toMatchObject({ appliedAmount: 240_000, excessAmount: 6_900 })
  })

  it("refuses beyond the replay cap when the caller does not take over-payments", () => {
    expect(() => projectReceipt({ loan, schedule, amount: 240_001, asOf, replayCapCents: 240_000 }))
      .toThrow("Receipt exceeds settlement amount:240000")
  })

  it("treats a zero cap as nothing owed: the whole receipt is excess", () => {
    const result = projectReceipt({ loan, schedule, amount: 5_000, asOf, allowOverpayment: true, replayCapCents: 0 })
    expect(result).toMatchObject({ appliedAmount: 0, excessAmount: 5_000, isCompleted: false })
  })
})

describe("N1: the replay cap bounds what a receipt applies, never whether it settles", () => {
  const day15 = new Date("2026-07-16T10:00:00.000Z")

  it("books a partial receipt on a daily-accrual bullet before maturity as a partial, with no s125 reprice", () => {
    // Charges live: the replay can absorb all R500, so its cap equals the amount.
    const result = projectReceipt({ loan, schedule, amount: 50_000, asOf: day15, replayCapCents: 50_000 })
    expect(result).toMatchObject({
      appliedAmount: 50_000, isCompleted: false, isEarlyDailySettlement: false, interestRebate: 0,
      totalInterest: 10_000, totalRepayable: 246_900,
    })
    expect(result.rows[0]).toMatchObject({ interestDue: 10_000, totalDue: 246_900, totalPaid: 50_000 })
  })

  it("still settles early at the lawful s125 figure when the receipt covers it", () => {
    const result = projectReceipt({ loan, schedule, amount: 241_900, asOf: day15, replayCapCents: 246_900 })
    expect(result).toMatchObject({
      settlementDue: 241_900, appliedAmount: 241_900, isCompleted: true, isEarlyDailySettlement: true,
      totalInterest: 5_000, totalRepayable: 241_900,
    })
  })
})
