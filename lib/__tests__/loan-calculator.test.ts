import { describe, it, expect } from "vitest"
import { calculateLoan, formatZAR } from "../loan-calculator"

const BASE = {
  productType: "MICRO",
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0,
  initiationFeeMax: 0,
  monthlyServiceFee: 0,
}

describe("calculateLoan — FLAT model", () => {
  it("calculates interest as principal * (rate/30) * days", () => {
    // R10,000 at 5%/month for 30 days → interest = 10000*0.05 = R500
    const result = calculateLoan(
      { ...BASE, principal: 1000000, termDays: 30, interestRatePm: 0.05, interestModel: "FLAT" },
      new Date("2026-01-01")
    )
    expect(result.totalInterest).toBe(50000) // R500.00 in cents
    expect(result.totalRepayable).toBe(1050000)
    expect(result.schedule).toHaveLength(1)
    expect(result.schedule[0].closingBalance).toBe(0)
  })

  it("sets due date to startDate + termDays", () => {
    const start = new Date("2026-01-01")
    const result = calculateLoan(
      { ...BASE, principal: 1000000, termDays: 15, interestRatePm: 0.05, interestModel: "FLAT" },
      start
    )
    const due = result.schedule[0].dueDate
    expect(due.getDate()).toBe(16) // Jan 1 + 15 days = Jan 16
  })

  it("produces a single-installment schedule", () => {
    const result = calculateLoan(
      { ...BASE, principal: 500000, termDays: 30, interestRatePm: 0.05, interestModel: "FLAT" },
      new Date("2026-01-01")
    )
    expect(result.schedule).toHaveLength(1)
    expect(result.schedule[0].totalDue).toBe(result.totalRepayable)
  })
})

describe("calculateLoan — REDUCING_BALANCE model", () => {
  it("generates monthly installments equal to termDays / 30 rounded", () => {
    // 6 months = 180 days
    const result = calculateLoan(
      { ...BASE, principal: 1000000, termDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" },
      new Date("2026-01-01")
    )
    expect(result.schedule).toHaveLength(6)
  })

  it("closing balance on final installment is 0", () => {
    const result = calculateLoan(
      { ...BASE, principal: 1000000, termDays: 360, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" },
      new Date("2026-01-01")
    )
    const last = result.schedule[result.schedule.length - 1]
    expect(last.closingBalance).toBe(0)
  })

  it("includes monthly service fee in each schedule item and totals", () => {
    const result = calculateLoan(
      { ...BASE, principal: 1000000, termDays: 90, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 6900 },
      new Date("2026-01-01")
    )
    result.schedule.forEach(item => {
      expect(item.feesDue).toBe(6900)
    })
    expect(result.serviceFees).toBe(6900 * 3)
  })

  it("each installment opening balance equals previous closing balance", () => {
    const result = calculateLoan(
      { ...BASE, principal: 2000000, termDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" },
      new Date("2026-01-01")
    )
    for (let i = 1; i < result.schedule.length; i++) {
      expect(result.schedule[i].openingBalance).toBe(result.schedule[i - 1].closingBalance)
    }
  })

  it("handles 0% interest rate without NaN (promotional rate edge case)", () => {
    // r=0 would cause 0/0 in PMT formula if not guarded
    const result = calculateLoan(
      { ...BASE, principal: 1000000, termDays: 180, interestRatePm: 0, interestModel: "REDUCING_BALANCE" },
      new Date("2026-01-01")
    )
    expect(Number.isNaN(result.totalInterest)).toBe(false)
    expect(result.totalInterest).toBe(0)
    expect(result.totalRepayable).toBe(1000000)
    expect(result.schedule[result.schedule.length - 1].closingBalance).toBe(0)
  })
})

describe("calculateLoan — DAILY_ACCRUAL model", () => {
  // interestRatePm is a MONTHLY rate for every model — the field name, the
  // product catalog (POFUND = 0.025), the seed appRates, and the statutory
  // credit-agreement PDF (which prints "% per month") all treat it as monthly.
  // DAILY_ACCRUAL spreads that monthly rate across the days in the term:
  // dailyRate = interestRatePm / 30. The previous code applied the monthly rate
  // PER DAY, over-charging PO funding ~30x (NCA s.100-105 usury).
  it("spreads the monthly rate across days (interestRatePm / 30)", () => {
    // R100,000 at 2.5%/month for 120 days → 0.025/30 * 120 = 0.10 → R10,000
    const result = calculateLoan(
      { ...BASE, principal: 10000000, termDays: 120, interestRatePm: 0.025, interestModel: "DAILY_ACCRUAL" },
      new Date("2026-01-01")
    )
    expect(result.totalInterest).toBe(Math.round(10000000 * (0.025 / 30) * 120))
    expect(result.totalInterest).toBe(1000000) // R10,000.00
  })

  it("golden: PO funding R200,000 / 90 days at 2.5%/month = R15,000 interest", () => {
    // The seed's LN-SEED-0004 (identical R200k/90d PO) booked R15,000.
    // The buggy per-day path produced R450,000 (225% of principal) — usury.
    const result = calculateLoan(
      { ...BASE, principal: 20000000, termDays: 90, interestRatePm: 0.025, interestModel: "DAILY_ACCRUAL", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.02 },
      new Date("2026-01-01")
    )
    expect(result.totalInterest).toBe(1500000) // R15,000.00 — NOT R450,000
  })

  it("produces a single-installment schedule", () => {
    const result = calculateLoan(
      { ...BASE, principal: 5000000, termDays: 60, interestRatePm: 0.025, interestModel: "DAILY_ACCRUAL" },
      new Date("2026-01-01")
    )
    expect(result.schedule).toHaveLength(1)
  })
})

describe("calculateLoan — initiation fee", () => {
  it("applies initiationFeePct as a percentage of principal", () => {
    // Principal chosen to sit UNDER the NCA Reg 42 ceiling so this still tests
    // the percentage itself. On R10,000 the statutory cap now binds first —
    // covered separately below and in lib/loan/nca-fee-cap.test.ts.
    const result = calculateLoan(
      { ...BASE, principal: 100000, termDays: 30, interestRatePm: 0, interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15 },
      new Date("2026-01-01")
    )
    expect(result.initiationFee).toBe(15000) // 15% of R1,000, below the R189.75 ceiling
  })

  it("caps initiation fee at initiationFeeMax when exceeded", () => {
    const result = calculateLoan(
      { ...BASE, principal: 10000000, termDays: 30, interestRatePm: 0, interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15, initiationFeeMax: 120750 },
      new Date("2026-01-01")
    )
    expect(result.initiationFee).toBe(120750)
  })

  it("initiationFeeMax 0 means no PRODUCT cap — the statutory one still applies", () => {
    // initiationFeeMax is a commercial setting; the NCA ceiling is not optional.
    // Below the ceiling, no cap binds:
    const small = calculateLoan(
      { ...BASE, principal: 100000, termDays: 30, interestRatePm: 0, interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15, initiationFeeMax: 0 },
      new Date("2026-01-01")
    )
    expect(small.initiationFee).toBe(15000) // 15% of R1,000, no product cap

    // Above it, the statute binds even with initiationFeeMax = 0:
    const large = calculateLoan(
      { ...BASE, principal: 10000000, termDays: 30, interestRatePm: 0, interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15, initiationFeeMax: 0 },
      new Date("2026-01-01")
    )
    // Independent literal — see the note in public-loan-products.test.ts.
    expect(large.initiationFee).toBe(120750) // R1,207.50, not R15,000
    expect(large.initiationFee).toBeLessThan(1500000)
  })

  it("includes initiation fee in totalRepayable", () => {
    const result = calculateLoan(
      { ...BASE, principal: 1000000, termDays: 30, interestRatePm: 0, interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15 },
      new Date("2026-01-01")
    )
    expect(result.totalRepayable).toBe(result.principal + result.totalInterest + result.initiationFee + result.serviceFees)
  })
})

describe("calculateLoan — initiation-fee payment mode + schedule footing", () => {
  const sumScheduleTotalDue = (s: { totalDue: number }[]) =>
    s.reduce((acc, r) => acc + r.totalDue, 0)

  // The core invariant: a consumer's instalment columns must add up to the
  // stated Total. Assert it across every model in both fee-payment modes.
  const cases = [
    { label: "FLAT", interestModel: "FLAT" as const, termDays: 30, interestRatePm: 0.05 },
    { label: "REDUCING_BALANCE", interestModel: "REDUCING_BALANCE" as const, termDays: 360, interestRatePm: 0.03 },
    { label: "DAILY_ACCRUAL", interestModel: "DAILY_ACCRUAL" as const, termDays: 90, interestRatePm: 0.025 },
  ]
  for (const c of cases) {
    it(`${c.label}: schedule foots to totalRepayable in DEFERRED mode`, () => {
      const r = calculateLoan(
        { principal: 2000000, termDays: c.termDays, interestRatePm: c.interestRatePm, interestModel: c.interestModel, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15, initiationFeeMax: 120750, monthlyServiceFee: 6900, initiationFeePayment: "DEFERRED", productType: "MICRO" },
        new Date("2026-01-01"),
      )
      expect(sumScheduleTotalDue(r.schedule)).toBe(r.totalRepayable)
      expect(r.disbursementAmount).toBe(r.principal) // full principal advanced
    })

    it(`${c.label}: schedule foots to totalRepayable in UPFRONT mode`, () => {
      const r = calculateLoan(
        { principal: 2000000, termDays: c.termDays, interestRatePm: c.interestRatePm, interestModel: c.interestModel, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15, initiationFeeMax: 120750, monthlyServiceFee: 6900, initiationFeePayment: "UPFRONT", productType: "MICRO" },
        new Date("2026-01-01"),
      )
      expect(sumScheduleTotalDue(r.schedule)).toBe(r.totalRepayable)
      // Fee deducted from the cash advanced; not collected through the schedule.
      expect(r.disbursementAmount).toBe(r.principal - r.initiationFee)
      expect(r.totalRepayable).toBe(r.principal + r.totalInterest + r.serviceFees)
    })
  }

  it("DEFERRED: the interest-free fee sits ONLY on instalment 1 (NCR Circular 15/2016 — no interest on the fee)", () => {
    const r = calculateLoan(
      { principal: 2000000, termDays: 360, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.054, initiationFeeMax: 0, monthlyServiceFee: 6900, initiationFeePayment: "DEFERRED", productType: "MICRO" },
      new Date("2026-01-01"),
    )
    // Instalment 1 fee column = the recurring service fee PLUS the one-time
    // initiation fee. Instalment 2 fee column = service fee only. The delta is
    // exactly the initiation fee — proving it is added once, interest-free.
    expect(r.schedule[0].feesDue - r.schedule[1].feesDue).toBe(r.initiationFee)
    // The fee is NOT in any interest column — interest is unchanged by the fee.
    const interestOnly = calculateLoan(
      { principal: 2000000, termDays: 360, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6900, productType: "MICRO" },
      new Date("2026-01-01"),
    )
    expect(r.totalInterest).toBe(interestOnly.totalInterest)
  })

  it("golden: audit loan R20,000 / 12mo / 3%pm / R1,080 fee / R69 service foots to the stated total", () => {
    // Audit LN-TEST-0001: schedule summed to R24,938.90 while the stated
    // total was R26,018.90 — a R1,080 gap = the initiation fee never billed.
    // initiationFeePct 0.054 of R20,000 = R1,080.
    const r = calculateLoan(
      { principal: 2000000, termDays: 360, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.054, initiationFeeMax: 0, monthlyServiceFee: 6900, initiationFeePayment: "DEFERRED", productType: "MICRO" },
      new Date("2026-01-01"),
    )
    expect(r.initiationFee).toBe(108000) // R1,080.00
    expect(sumScheduleTotalDue(r.schedule)).toBe(r.totalRepayable) // foots — the R1,080 gap is closed
  })
})

describe("calculateLoan — monthly service fee on single-payment (bullet) loans", () => {
  it("FLAT 30-day micro loan bills one R60+VAT (R69) service fee, folded into the single instalment", () => {
    const r = calculateLoan(
      { principal: 100000, termDays: 30, interestRatePm: 0.05, interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 6900, productType: "MICRO" },
    )
    // R1,000 + 5% interest R50 + 15% init R150 (under the R1,000 cap) + R69 service
    expect(r.serviceFees).toBe(6900)
    expect(r.schedule[0].feesDue).toBe(15000 + 6900) // deferred initiation + service fee
    expect(r.totalRepayable).toBe(100000 + 5000 + 15000 + 6900) // R1,269.00
    expect(r.schedule[0].totalDue).toBe(r.totalRepayable) // single payment still foots
  })

  it("prices the approved MICRO30 daily-accrual + R69 contract exactly", () => {
    const r = calculateLoan(
      {
        principal: 100000,
        termDays: 30,
        interestRatePm: 0.05,
        interestModel: "DAILY_ACCRUAL",
        initiationFeeModel: "FLAT_PCT" as const,
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 6900,
        productType: "MICRO",
      },
      new Date("2026-07-01T00:00:00.000Z"),
    )

    expect(r).toMatchObject({
      principal: 100000,
      totalInterest: 5000,
      initiationFee: 15000,
      serviceFees: 6900,
      totalRepayable: 126900,
    })
    expect(r.schedule).toHaveLength(1)
    expect(r.schedule[0]).toMatchObject({
      principalDue: 100000,
      interestDue: 5000,
      feesDue: 21900,
      totalDue: 126900,
    })
  })

  it("charges one service fee PER MONTH of the term (round(termDays/30))", () => {
    const r = calculateLoan(
      { principal: 100000, termDays: 60, interestRatePm: 0.05, interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6900, productType: "MICRO" },
    )
    expect(r.serviceFees).toBe(6900 * 2) // 60 days ≈ 2 months
  })

  it("no service fee when the product configures monthlyServiceFee = 0 (e.g. PO funding)", () => {
    const r = calculateLoan(
      { principal: 2500000, termDays: 45, interestRatePm: 0.025, interestModel: "DAILY_ACCRUAL", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.02, initiationFeeMax: 0, monthlyServiceFee: 0, productType: "PO_FUNDING" },
    )
    expect(r.serviceFees).toBe(0)
  })

  it("does NOT double-charge REDUCING_BALANCE — the per-instalment path bills it, the bullet block is skipped", () => {
    const r = calculateLoan(
      { principal: 2000000, termDays: 90, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6900, productType: "MICRO" },
    )
    // 3 monthly instalments × R69 = R207 exactly — NOT R207 + an extra bullet fee.
    expect(r.serviceFees).toBe(6900 * 3)
  })
})

describe("formatZAR", () => {
  // The gap after "R" is a NON-BREAKING space (U+00A0) so the symbol never wraps
  // onto its own line in narrow UI cards. The plain-space formatter for SMS/NCA
  // lives in lib/utils.ts.
  it("formats cents as rand with 2 decimal places", () => {
    expect(formatZAR(100000)).toBe("R\u00A01,000.00")
    expect(formatZAR(50)).toBe("R\u00A00.50")
  })

  it("formats zero correctly", () => {
    expect(formatZAR(0)).toBe("R\u00A00.00")
  })

  it("adds thousands separator", () => {
    expect(formatZAR(100000000)).toBe("R\u00A01,000,000.00")
  })
})
