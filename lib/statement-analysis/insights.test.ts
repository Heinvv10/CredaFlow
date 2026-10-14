import { describe, expect, it } from "vitest"
import { computeInsights, type InsightStatement } from "./insights"
import type { StatementRead, StatementTransaction } from "./types"

const row = (date: string, description: string, amountCents: number, balanceCents: number | null = null): StatementTransaction =>
  ({ date, description, amountCents, balanceCents, page: 1 })

function statement(rows: StatementTransaction[], over: Partial<StatementRead> = {}, extra: Partial<InsightStatement> = {}): InsightStatement {
  return {
    documentId: "doc-1",
    bank: "CAPITEC",
    balanceCheck: "PASS",
    read: { accountHolderName: "T TESTER", accountNumberLast4: "0001", periodStart: "2026-07-01", periodEnd: "2026-07-30", openingBalanceCents: 100_000, closingBalanceCents: null, transactions: rows, ...over },
    ...extra,
  }
}

const ctx = { clientName: "Thabo Tester", declaredExpensesCents: 300_000 }
const july = [
  row("2026-07-02", "Card Purchase: SHOPRITE", -200_000),
  row("2026-07-05", "Card Purchase: HOLLYWOODBETS", -50_000),
  row("2026-07-06", "DebiCheck: SYNTHLEND FINANCE", -125_000),
  row("2026-07-07", "ATM Cash Withdrawal", -40_000),
  row("2026-07-08", "Payment To: J SOAP", -30_000),
  row("2026-07-10", "Prepaid Airtime: VODACOM", -10_000),
  row("2026-07-25", "Payment Received: SALARY SYNTHCO", 1_000_000),
  row("2026-07-27", "EDO Collection Attempt SYNTHLEND", 125_000, null),
]
july[7].nonPosting = true

describe("computeInsights", () => {
  it("adds money in and out per month, without non-posting rows", () => {
    const ins = computeInsights([statement(july)], ctx)
    expect(ins.months).toEqual([expect.objectContaining({ month: "2026-07", inCents: 1_000_000, outCents: 455_000, salaryCredits: 1 })])
    expect(ins.months[0].byCategory).toMatchObject({ FOOD: 200_000, GAMBLING: 50_000, CREDIT_INSTALMENT: 125_000, CASH_WITHDRAWAL: 40_000, UNCATEGORISED: 30_000, UTILITIES_TELECOM: 10_000 })
  })

  it("counts only living categories as living spend, per month of coverage, and shows the rest apart", () => {
    const ins = computeInsights([statement(july)], ctx)
    expect(ins.coverageDays).toBe(30)
    // R2,100 over 30 days is R2,131 per 30.44-day month.
    expect(ins.living.monthlyCents).toBe(Math.round(210_000 / (30 / 30.44)))
    expect(Object.keys(ins.living.byCategoryMonthlyCents).sort()).toEqual(["FOOD", "UTILITIES_TELECOM"])
    expect(Object.keys(ins.living.excludedMonthlyCents).sort()).toEqual(["CASH_WITHDRAWAL", "CREDIT_INSTALMENT", "GAMBLING", "UNCATEGORISED"])
    expect(ins.gapCents).toBe(ins.living.monthlyCents - 300_000)
    expect(ins.uncategorisedShare).toBeCloseTo(30_000 / 455_000)
  })

  it("leaves out a statement that does not reconcile, but still lists it", () => {
    const ins = computeInsights([statement(july, {}, { balanceCheck: "FAIL" })], ctx)
    expect(ins.months).toEqual([])
    expect(ins.coverageDays).toBe(0)
    expect(ins.enoughCoverage).toBe(false)
    expect(ins.statements).toEqual([expect.objectContaining({ documentId: "doc-1", used: false })])
  })

  it("counts an account's overlapping statements' days once", () => {
    const a = statement([row("2026-07-02", "Card Purchase: SHOPRITE", -100_000), row("2026-07-20", "Card Purchase: SHOPRITE", -100_000)])
    const b = statement([row("2026-07-20", "Card Purchase: SHOPRITE", -100_000), row("2026-08-05", "Card Purchase: SHOPRITE", -100_000)],
      { periodStart: "2026-07-15", periodEnd: "2026-08-14" }, { documentId: "doc-2" })
    const ins = computeInsights([a, b], ctx)
    expect(ins.coverageDays).toBe(45)
    expect(ins.months.map((m) => [m.month, m.outCents])).toEqual([["2026-07", 200_000], ["2026-08", 100_000]])
  })

  it("needs four weeks of statements before living spend can be compared", () => {
    expect(computeInsights([statement(july, { periodEnd: "2026-07-27" })], ctx).enoughCoverage).toBe(false)
    expect(computeInsights([statement(july, { periodEnd: "2026-07-28" })], ctx).enoughCoverage).toBe(true)
  })

  it("reads the salary's regularity: first salary credit day each month and the spread", () => {
    const rows = [row("2026-07-25", "SALARY SYNTHCO", 900_000), row("2026-08-28", "SALARY SYNTHCO", 900_000), row("2026-08-30", "SALARY SYNTHCO BONUS", 100_000)]
    const ins = computeInsights([statement(rows, { periodEnd: "2026-08-31" })], ctx)
    expect(ins.salary).toEqual({ payDays: [25, 28], daySpread: 3 })
    expect(ins.months.map((m) => m.salaryCredits)).toEqual([1, 2])
  })

  it("averages end-of-day balances over the period and finds the lowest", () => {
    const rows = [row("2026-07-11", "Card Purchase: SHOPRITE", -150_000, -50_000), row("2026-07-21", "SALARY SYNTHCO", 150_000, 100_000)]
    const ins = computeInsights([statement(rows)], ctx)
    // 10 days at R1,000, 10 at -R500, 10 at R1,000.
    expect(ins.statements[0]).toMatchObject({ averageBalanceCents: 50_000, lowestBalanceCents: -50_000 })
  })

  it("has no gap without a declared figure", () => {
    expect(computeInsights([statement(july)], { clientName: null, declaredExpensesCents: null }).gapCents).toBeNull()
  })
})
