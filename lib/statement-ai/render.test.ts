import { describe, expect, it } from "vitest"
import { computeInsights } from "@/lib/statement-analysis/insights"
import { runChecks } from "@/lib/credit-checks/run-checks"
import { facts as factsOf, statement } from "@/lib/credit-checks/facts.test-helpers"
import { syntheticTransactions } from "./synthetic.test-helpers"
import { buildPlans, produce } from "./generate"
import { checkFigures } from "./post-check"
import { renderResult, renderSummary, SUMMARY_CLAIMS } from "./render"
import { askRows, runQuery } from "./ask/tools"

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
    expect(out.text).toMatch(/^The statements cover 92 days from 2026-07-01 to 2026-09-30/)
    expect(n).toBe(2)
    const bad = await produce(summary, async () => '{"claims": ["looks_fine"]}')
    expect(bad).toMatchObject({ status: "REJECTED", rejectReason: expect.stringMatching(/invalid claims/) })
  })
})

describe("renderExplanation", () => {
  it("writes each flag from its rule, threshold and evidence, with no model", () => {
    const gambling = explanations.find((e) => e.flagCode === "GAMBLING")!
    expect(gambling.text).toContain("GAMBLING (RISK_BEHAVIOUR): Betting and lottery spend per month is compared with the client's monthly income")
    expect(gambling.text).toContain("The rule raises it when the figure is above the policy threshold.")
    expect(gambling.text).toContain("Policy threshold: betting above 5% of monthly income.")
    expect(gambling.text).toMatch(/Evidence rows: S1-R\d+ 2026-07-12 HOLLYWOODBETS R1 500.00 out/)
    expect(explanations.every((e) => e.text !== null)).toBe(true)
  })
})

describe("renderResult", () => {
  const ask = askRows([{ ref: "S1", transactions: read.transactions.map((t, index) => ({ index, t })) }], "T TESTER")
  it("labels each result with its query and shows its filter as the filter", () => {
    expect(renderResult(runQuery(ask, { id: "q1", tool: "count", filter: { payee: "SYNTH RENTALS" } }))).toBe("[q1] Rows for all rows to SYNTH RENTALS: 3.")
    expect(renderResult(runQuery(ask, { id: "q2", tool: "groupByMonth", filter: { direction: "in" }, measure: "sum" }))).toBe(
      "[q2] By month for money in: 2026-07 R18 450.00 (1 row); 2026-08 R18 450.00 (1 row); 2026-09 R18 450.00 (1 row).",
    )
    expect(renderResult(runQuery(ask, { id: "q3", tool: "list", filter: { payee: "SYNTH RENTALS" }, limit: 1 }))).toBe(
      "[q3] Rows for all rows to SYNTH RENTALS: S1-R5 2026-07-27 SYNTH RENTALS R6 500.00 out; 3 rows match in all.",
    )
  })
})
