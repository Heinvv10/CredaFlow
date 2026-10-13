import { describe, expect, it } from "vitest"
import { salaryMatch } from "./salary-match"
import { codes, facts, statement, tx } from "./facts.test-helpers"
import type { PayslipFacts } from "./types"

const payslip = (over: Partial<PayslipFacts> = {}): PayslipFacts => ({
  documentId: "slip-1", validated: true, netPayCents: 1_845_000, payDate: "2026-09-25", ...over,
})
// The statement covers 2026-07-01..2026-09-30: three pay dates, 25 Jul/Aug/Sep.
const paid = (jul: number, aug: number, sep: number, day = "25") => statement([
  tx(`2026-07-${day}`, "Payment Received: SALARY SYNTHCO", jul),
  tx(`2026-08-${day}`, "Payment Received: SALARY SYNTHCO", aug),
  tx(`2026-09-${day}`, "Payment Received: SALARY SYNTHCO", sep),
])

describe("salaryMatch", () => {
  it("raises nothing when every covered month has the net pay credited near the pay date", () => {
    expect(salaryMatch(facts({ payslip: payslip(), statements: [paid(1_845_000, 1_845_000, 1_845_000)] }))).toEqual([])
  })

  it("accepts a credit within R50 or 2% of net pay, whichever is larger", () => {
    // 2% of R18 450 = R369 > R50.
    expect(salaryMatch(facts({ payslip: payslip(), statements: [paid(1_845_000 - 36_900, 1_845_000 + 36_900, 1_845_000)] }))).toEqual([])
    expect(codes(salaryMatch(facts({ payslip: payslip(), statements: [paid(1_845_000 - 37_000, 1_845_000, 1_845_000)] })))).toEqual(["SALARY_AMOUNT_MISMATCH"])
  })

  it("uses the R50 floor for small net pay", () => {
    const small = payslip({ netPayCents: 200_000 })
    expect(salaryMatch(facts({ payslip: small, statements: [paid(195_000, 200_000, 200_000)] }))).toEqual([])
    expect(codes(salaryMatch(facts({ payslip: small, statements: [paid(194_900, 200_000, 200_000)] })))).toEqual(["SALARY_AMOUNT_MISMATCH"])
  })

  it("accepts the salary up to 5 days either side of the pay date, and not 6", () => {
    expect(salaryMatch(facts({ payslip: payslip(), statements: [paid(1_845_000, 1_845_000, 1_845_000, "30")] }))).toEqual([])
    const late = statement([
      tx("2026-07-25", "SALARY", 1_845_000), tx("2026-08-25", "SALARY", 1_845_000), tx("2026-09-19", "SALARY", 1_845_000),
    ])
    const out = salaryMatch(facts({ payslip: payslip(), statements: [late] }))
    expect(codes(out)).toEqual(["NO_SALARY_CREDIT"])
    expect(out[0].evidence).toMatchObject({ month: "2026-09", expectedDate: "2026-09-25" })
  })

  it("raises NO_SALARY_CREDIT per month with no credit of salary size, and ignores debits", () => {
    const s = statement([tx("2026-07-25", "SALARY", 1_845_000), tx("2026-08-25", "Card Purchase", -1_845_000), tx("2026-09-25", "Small credit", 10_000)])
    expect(codes(salaryMatch(facts({ payslip: payslip(), statements: [s] })))).toEqual(["NO_SALARY_CREDIT", "NO_SALARY_CREDIT"])
  })

  it("skips a month whose pay window the statement does not fully cover", () => {
    const s = paid(1_845_000, 1_845_000, 1_845_000)
    s.read!.periodEnd = "2026-09-28" // 25 Sep + 5 days is past the end
    s.read!.transactions.pop()
    expect(salaryMatch(facts({ payslip: payslip(), statements: [s] }))).toEqual([])
  })

  it("raises PAYSLIP_UNVALIDATED instead of matching on figures that failed validation", () => {
    const out = salaryMatch(facts({ payslip: payslip({ validated: false }), statements: [paid(1, 1, 1)] }))
    expect(codes(out)).toEqual(["PAYSLIP_UNVALIDATED"])
  })

  it("raises nothing without a payslip, and nothing without a read statement", () => {
    expect(salaryMatch(facts({ statements: [paid(1, 1, 1)] }))).toEqual([])
    expect(salaryMatch(facts({ payslip: payslip(), statements: [] }))).toEqual([])
  })
})
