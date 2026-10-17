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
    // 2026-07-30 is the first statement's last day: the second's row on it is the same day, counted once.
    const b = statement([row("2026-07-20", "Card Purchase: SHOPRITE", -100_000), row("2026-07-30", "Card Purchase: SHOPRITE", -100_000), row("2026-08-05", "Card Purchase: SHOPRITE", -100_000)],
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

  it("does not merge two statements of one bank that print no account number: they may be two accounts", () => {
    const a = statement([row("2026-07-02", "Card Purchase: SHOPRITE", -100_000)], { accountNumberLast4: null })
    const b = statement([row("2026-07-02", "Card Purchase: SHOPRITE", -100_000)], { accountNumberLast4: null }, { documentId: "doc-2" })
    expect(computeInsights([a, b], ctx).months[0].outCents).toBe(200_000)
  })

  it("shows no gap under four weeks of coverage", () => {
    const ins = computeInsights([statement(july, { periodEnd: "2026-07-20" })], ctx)
    expect(ins.enoughCoverage).toBe(false)
    expect(ins.gapCents).toBeNull()
  })

  it("takes each month's earliest salary day, whatever order the rows print in", () => {
    const rows = [row("2026-07-28", "SALARY SYNTHCO", 100_000), row("2026-07-25", "SALARY SYNTHCO", 900_000)]
    expect(computeInsights([statement(rows)], ctx).salary.payDays).toEqual([25])
  })
})

describe("computeInsights with model labels", () => {
  const rows = [
    row("2026-07-02", "Card Purchase: SYNTH CORNER 4411", -100_000),
    row("2026-07-03", "Card Purchase: SHOPRITE", -50_000),
    row("2026-07-04", "Payment To: J SOAP", -30_000),
  ]

  it("counts a model-labelled debit in its category and lists it as model-assigned", () => {
    const ins = computeInsights([statement(rows, {}, { modelLabels: { "SYNTH CORNER": "FOOD", "J SOAP": "UNCATEGORISED" } })], ctx)
    expect(ins.months[0].byCategory).toMatchObject({ FOOD: 150_000, UNCATEGORISED: 30_000 })
    expect(ins.modelAssigned).toMatchObject({ debitCents: 100_000, rowCount: 1, rows: [{ documentId: "doc-1", date: "2026-07-02", description: "Card Purchase: SYNTH CORNER 4411", amountCents: -100_000, category: "FOOD" }] })
    expect(ins.modelAssigned.livingMonthlyCents).toBe(Math.round(100_000 / (30 / 30.44)))
    expect(ins.modelAssigned.digest).toMatch(/^[0-9a-f]{16}$/)
    expect(ins.statements[0].modelLabelled).toBe(true)
  })

  it("applies a statement's labels to its own rows only", () => {
    const a = statement(rows.slice(0, 1), {}, { documentId: "doc-a", modelLabels: { "SYNTH CORNER": "FOOD" } })
    const b = statement([row("2026-07-02", "Card Purchase: SYNTH CORNER 4411", -100_000)], { accountNumberLast4: "0002" }, { documentId: "doc-b" })
    const ins = computeInsights([a, b], ctx)
    expect(ins.months[0].byCategory).toMatchObject({ FOOD: 100_000, UNCATEGORISED: 100_000 })
    expect(ins.statements.map((s) => s.modelLabelled)).toEqual([true, false])
  })

  it("without labels: rules alone, nothing model-assigned", () => {
    const ins = computeInsights([statement(rows)], ctx)
    expect(ins.modelAssigned).toEqual({ debitCents: 0, livingMonthlyCents: 0, rowCount: 0, rows: [], digest: null })
    expect(ins.statements[0].modelLabelled).toBe(false)
  })
})

describe("aboveDeclared: a hint, not a flag", () => {
  it("holds only beyond both EXPENSE_UNDERSTATED margins, with a month of coverage", () => {
    const spend = (cents: number) => [row("2026-07-02", "Card Purchase: SHOPRITE", -cents)]
    const at = (cents: number, declared: number | null, over: Partial<StatementRead> = {}) =>
      computeInsights([statement(spend(cents), over)], { clientName: null, declaredExpensesCents: declared }).aboveDeclared
    expect(at(2_000_000, 300_000)).toBe(true)
    // 30 days of coverage scale R4,400 to about R4,465 a month: R1,465 above, under R1,500.
    expect(at(300_000 + 140_000, 300_000)).toBe(false)
    expect(at(2_000_000, null)).toBe(false)
    expect(at(2_000_000, 300_000, { periodEnd: "2026-07-20" })).toBe(false)
  })
})
