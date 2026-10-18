import { describe, expect, it } from "vitest"
import { computeInsights } from "@/lib/statement-analysis/insights"
import { runChecks } from "@/lib/credit-checks/run-checks"
import { facts as factsOf, statement } from "@/lib/credit-checks/facts.test-helpers"
import { syntheticTransactions } from "./synthetic.test-helpers"
import { buildPlans, produce } from "./generate"
import { checkFigures } from "./post-check"
import { renderResult, renderSummary, SUMMARY_CLAIMS } from "./render"
import { askRows, runQuery } from "./ask/tools"
import { checkAnswer } from "./ask/answer"

const st = statement(syntheticTransactions())
const read = st.read!
const insights = computeInsights([{ documentId: "doc-1", bank: "CAPITEC", balanceCheck: "PASS", read }], { clientName: "T TESTER", declaredExpensesCents: 400_000 })
const flags = runChecks(factsOf({ clientName: "Thabo Tester", monthlyIncomeCents: 1_845_000, declaredExpensesCents: 400_000, statements: [st] }))
const rows = read.transactions.map((t) => ({ t, s: { documentId: "doc-1", bank: "CAPITEC", balanceCheck: "PASS", read } }))
const { summary, explanations } = buildPlans(insights, rows, flags as never, new Map([["an-1", read.transactions]]), "T TESTER")

describe("renderSummary", () => {
  it("writes every claim from the facts, and every figure in it passes the figure check", () => {
    const text = renderSummary([...SUMMARY_CLAIMS], summary.built.facts)
    expect(checkFigures(text, summary.built.allowed)).toEqual({ ok: true })
    expect(text).toContain("Over the period, money in was R55 350.00 and money out was R32 086.50.")
    expect(text).toContain("Living spend is R7 886.77 a month, R3 886.77 above the declared R4 000.00 a month.")
    expect(text).not.toContain("TESTER")
    // Each pay day once.
    expect(text).toMatch(/on day 25 of the month/)
  })
  it("always says which flags were raised, even if the model left them out", () => {
    const text = renderSummary(["money"], summary.built.facts)
    expect(text).toMatch(/Flags raised by the credit checks: .*GAMBLING \(RISK_BEHAVIOUR/)
  })
})

describe("produce (summary)", () => {
  it("takes only a valid claims list from the model, and asks again otherwise", async () => {
    let n = 0
    const out = await produce(summary, async () => (++n === 1 ? "Here is a summary: all looks fine." : '{"claims": ["coverage", "living"]}'))
    expect(out).toMatchObject({ status: "OK", claims: ["coverage", "living"] })
    expect(out.text).toMatch(/^The reconciled statements cover 92 days from 2026-07-01 to 2026-09-30, across 1 statement, all reconciled\./)
    expect(n).toBe(2)
    const bad = await produce(summary, async () => '{"claims": ["looks_fine"]}')
    expect(bad).toMatchObject({ status: "REJECTED", rejectReason: expect.stringMatching(/invalid claims/) })
  })
})

describe("renderExplanation", () => {
  it("writes each flag from its rule, threshold and evidence, with no model", () => {
    const gambling = explanations.find((e) => e.flagCode === "GAMBLING")!
    expect(gambling.text).toContain("GAMBLING (RISK_BEHAVIOUR): Betting and lottery spend per month is compared with the client's monthly income")
    expect(gambling.text).toContain("It is raised when betting a month is at least the policy share of monthly income.")
    expect(gambling.text).toContain("Policy threshold: betting of at least 5% of monthly income.")
    expect(gambling.text).toMatch(/Evidence rows: S1-R\d+ 2026-07-12 "HOLLYWOODBETS" R1 500.00 out/)
    expect(explanations.every((e) => e.text !== null)).toBe(true)
  })
})

describe("renderResult", () => {
  const ask = askRows([{ ref: "S1", transactions: read.transactions.map((t, index) => ({ index, t })) }], "T TESTER")
  it("labels each result with its query and shows its filter as the filter", () => {
    expect(renderResult(runQuery(ask, { id: "q1", tool: "count", filter: { payee: "SYNTH RENTALS" } }))).toBe("[q1] Rows for all rows with \"SYNTH RENTALS\": 3.")
    expect(renderResult(runQuery(ask, { id: "q2", tool: "groupByMonth", filter: { direction: "in" }, measure: "sum" }))).toBe(
      "[q2] By month for money in: 2026-07 R18 450.00 (1 row); 2026-08 R18 450.00 (1 row); 2026-09 R18 450.00 (1 row).",
    )
    expect(renderResult(runQuery(ask, { id: "q4", tool: "groupByMonth", filter: {}, measure: "sum" }))).toMatch(
      /^\[q4\] By month for all rows \(net totals: a minus means more went out than came in\): 2026-07/,
    )
    expect(renderResult(runQuery(ask, { id: "q5", tool: "groupByPayee", filter: { direction: "out" }, measure: "sum", limit: 2 }))).toMatch(
      /^\[q5\] By payee for money out, the largest 2 payees: "SYNTH RENTALS" R19 500.00/,
    )
    expect(renderResult(runQuery(ask, { id: "q3", tool: "list", filter: { payee: "SYNTH RENTALS" }, limit: 1, order: "date" }))).toBe(
      "[q3] Rows for all rows with \"SYNTH RENTALS\", in date order: S1-R5 2026-07-27 \"SYNTH RENTALS\" R6 500.00 out; 3 rows match in all.",
    )
    const largest = runQuery(ask, { id: "q6", tool: "list", filter: { direction: "out" }, limit: 3, order: "largest" })
    expect(renderResult(largest)).toMatch(/^\[q6\] Rows for money out, largest amount at the top: /)
    // Its own wording passes the figure check: an ordered list is shown, not rejected.
    expect(checkAnswer(renderResult(largest), [largest])).toEqual({ ok: true })
  })
})

describe("review round 4: what the sentences must never say", () => {
  const base = summary.built.facts
  it("does not say no expenses were declared when coverage is only too short to compare", () => {
    const short = { ...base, coverageDays: 20, livingSpendComparedWithDeclared: null, livingSpendDifferenceFromDeclaredPerMonth: null }
    const text = renderSummary(["living"], { ...short, raisedFlags: [] })
    expect(text).toBe("Living spend is R7 886.77 a month, from 20 days of reconciled statements; that is under the 28 days needed, so it is not compared with the declared R4 000.00.")
  })
  it("marks a statement that does not reconcile, and counts only the reconciled", () => {
    const two = { ...base, raisedFlags: [], statementCount: 2, reconciledStatementCount: 1, statements: [...base.statements, { ref: "S2", bank: "FNB", periodStart: "2026-10-01", periodEnd: "2026-10-31", reconciled: false, averageBalance: "R1.00", lowestBalance: "R1.00" }] }
    const text = renderSummary(["coverage", "balances"], two)
    expect(text).toContain("across 2 statements, of which 1 reconcile and count in the figures")
    expect(text).toContain("to 2026-09-30")
    expect(text).toContain("S2 (FNB) is not reconciled and is left out of the figures")
  })
  it("states the salary mismatch both ways, never as a threshold the figure is under", () => {
    const [low] = buildPlans(insights, rows, [{ code: "SALARY_AMOUNT_MISMATCH", check: "SALARY_MATCH", evidence: { creditCents: 1_000_000, netPayCents: 1_845_000 } }] as never, new Map(), "T TESTER").explanations
    expect(low.text).toContain("The credit found is below the payslip's net pay by more than the tolerance; the rule raises it on a difference either way.")
    expect(low.text).not.toMatch(/below the policy threshold/)
  })
  it("explains betting with no known income as such, with no share of income", () => {
    const [g] = buildPlans(insights, rows, [{ code: "GAMBLING", check: "RISK_BEHAVIOUR", evidence: { monthlyCents: 150_000, monthlyIncomeCents: null } }] as never, new Map(), "T TESTER").explanations
    expect(g.text).toContain("the client's monthly income is not known")
    expect(g.text).not.toMatch(/share of monthly income|5%/)
  })
  it("explains every flag, not one per code", () => {
    const two = [
      { code: "UNDISCLOSED_DEBIT_ORDER", check: "UNDISCLOSED_DEBT", evidence: { counterparty: "A" } },
      { code: "UNDISCLOSED_DEBIT_ORDER", check: "UNDISCLOSED_DEBT", evidence: { counterparty: "B" } },
    ]
    expect(buildPlans(insights, rows, two as never, new Map(), "T TESTER").explanations).toHaveLength(2)
  })
  it("says when a rule found more rows than it lists", () => {
    const many = [{ code: "RETURNED_DEBIT", check: "RISK_BEHAVIOUR", evidence: { documentId: "doc-1", analysisId: "an-1", transactionIndexes: [1, 7], occurrences: 25 } }]
    const [e] = buildPlans(insights, rows, many as never, new Map([["an-1", read.transactions]]), "T TESTER").explanations
    expect(e.text).toContain("The rule found 25 rows; the first 2 are listed.")
  })
})


describe("review round 5", () => {
  const ask = askRows([{ ref: "S1", transactions: read.transactions.map((t, index) => ({ index, t })) }], "T TESTER")
  it("says the largest payee, not the largest 1 payees", () => {
    expect(renderResult(runQuery(ask, { id: "q1", tool: "groupByPayee", filter: { direction: "out" }, measure: "sum", limit: 1 }))).toMatch(/^\[q1\] By payee for money out, the largest payee: "SYNTH RENTALS"/)
  })
  it("calls an average with no direction a net average", () => {
    expect(renderResult(runQuery(ask, { id: "q1", tool: "average", filter: {} }))).toMatch(/^\[q1\] Net average amount \(money in less money out, per row; a minus means more went out than came in\) for all rows: /)
    expect(renderResult(runQuery(ask, { id: "q2", tool: "average", filter: { direction: "out" } }))).toMatch(/^\[q2\] Average amount for money out: /)
  })
  it("figure-checks a payee named with a direction word as a name, but not one named with a figure word", () => {
    const out = read.transactions.find((t) => t.amountCents < 0)!
    const salaryCo = askRows([{ ref: "S1", transactions: [{ index: 0, t: { ...out, description: "SALARY ADVANCE CO" } }, { index: 1, t: { ...out, description: "SPAR WESTVILLE" } }] }], "T TESTER")
    for (const q of [runQuery(salaryCo, { id: "q1", tool: "list", filter: {}, limit: 5, order: "date" }), runQuery(salaryCo, { id: "q2", tool: "groupByPayee", filter: { direction: "out" }, measure: "sum", limit: 5 })]) {
      expect(checkAnswer(renderResult(q), [q])).toEqual({ ok: true })
    }
    expect(checkFigures('Rows for all rows with "SALARY ADVANCE CO".', { amountsCents: [] })).toEqual({ ok: true })
    expect(checkFigures('Rows for all rows with "FIVE THOUSAND".', { amountsCents: [] })).toMatchObject({ ok: false })
  })
})
