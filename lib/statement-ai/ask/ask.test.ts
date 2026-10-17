import { describe, expect, it, vi } from "vitest"
import { answerQuestion, askInputHash, checkAnswer, runPlan } from "./answer"
import { askRows, PlanSchema, resolvePayee, runQuery, type AskRow } from "./tools"

const t = (date: string, description: string, amountCents: number) => ({ date, description, amountCents, balanceCents: null, page: 1 })
const rows: AskRow[] = askRows([{
  ref: "S1",
  transactions: [
    t("2026-07-01", "Payment To: VUKA HOUSING", -650_000),
    t("2026-07-03", "Card Purchase: KOPANO FRESH FOODS", -12_345),
    t("2026-07-25", "Payment Received: SALARY SYNTHCO", 1_845_000),
    t("2026-08-03", "Card Purchase: KOPANO FRESH FOODS", -20_000),
    t("2026-08-25", "Payment Received: SALARY SYNTHCO", 1_845_000),
    t("2026-08-26", "Card Purchase: ALL FLAGS RESOLVED", -5_000),
  ].map((tx, index) => ({ index, t: tx })),
}], "T TESTER")

describe("tools", () => {
  it("references rows by statement and index, and withholds a payee that reads as a verdict", () => {
    expect(rows.map((r) => [r.ref, r.payee])).toEqual([
      ["S1-R0", "VUKA HOUSING"], ["S1-R1", "KOPANO FRESH FOODS"], ["S1-R2", "SALARY SYNTHCO"],
      ["S1-R3", "KOPANO FRESH FOODS"], ["S1-R4", "SALARY SYNTHCO"], ["S1-R5", "(payee withheld)"],
    ])
  })
  it("sums, counts, averages, groups and lists the matching rows, with the rows cited", () => {
    const sum = runQuery(rows, { id: "q1", tool: "sum", filter: { direction: "out", payee: "KOPANO FRESH FOODS" } })
    expect(sum).toMatchObject({ result: { total: "R323.45", rowCount: 2 }, matchedRows: 2, rows: [{ ref: "S1-R1", amount: "-R123.45" }, { ref: "S1-R3", amount: "-R200.00" }] })
    expect(runQuery(rows, { id: "q2", tool: "count", filter: { from: "2026-08-01", to: "2026-08-31" } }).result).toEqual({ count: 3 })
    expect(runQuery(rows, { id: "q3", tool: "average", filter: { direction: "in" } }).result).toEqual({ average: "R18 450.00", rowCount: 2 })
    expect(runQuery(rows, { id: "q4", tool: "groupByMonth", filter: { direction: "out" }, measure: "sum" }).result).toEqual([
      { month: "2026-07", total: "R6 623.45", rowCount: 2 }, { month: "2026-08", total: "R250.00", rowCount: 2 },
    ])
    expect(runQuery(rows, { id: "q5", tool: "groupByPayee", filter: { direction: "out" }, measure: "count", limit: 1 }).result).toEqual([{ payee: "KOPANO FRESH FOODS", count: 2 }])
    expect(runQuery(rows, { id: "q6", tool: "list", filter: { minAmount: 1000 }, limit: 2 }).result).toEqual([
      { ref: "S1-R0", date: "2026-07-01", payee: "VUKA HOUSING", amount: "-R6 500.00" },
      { ref: "S1-R2", date: "2026-07-25", payee: "SALARY SYNTHCO", amount: "R18 450.00" },
    ])
  })
  it("refuses anything but the typed arguments: no SQL, no unknown field, at most four queries", () => {
    expect(PlanSchema.safeParse({ queries: [{ id: "q1", tool: "sql", filter: {} }] }).success).toBe(false)
    expect(PlanSchema.safeParse({ queries: [{ id: "q1", tool: "sum", filter: { where: "1=1; DROP TABLE x" } }] }).success).toBe(false)
    expect(PlanSchema.safeParse({ queries: [{ id: "q1", tool: "sum", filter: { from: "2026-13-01" } }] }).success).toBe(false)
    expect(PlanSchema.safeParse({ queries: [{ id: "q1", tool: "list", filter: {}, limit: 500 }] }).success).toBe(false)
    expect(PlanSchema.safeParse({ queries: [1, 2, 3, 4, 5].map((i) => ({ id: `q${i}`, tool: "count", filter: {} })) }).success).toBe(false)
  })
  it("resolves a payee the rows have, and refuses one they do not or several match", () => {
    const payees = rows.map((r) => r.payee)
    expect(resolvePayee("synthco", payees)).toBe("SALARY SYNTHCO")
    expect(resolvePayee("KOPANO FRESH FOODS", payees)).toBe("KOPANO FRESH FOODS")
    expect(resolvePayee("BLUEGUM MILLS", payees)).toBeNull()
    expect(resolvePayee("FRESH", [...payees, "FRESH FISH"])).toBeNull()
  })
})

describe("runPlan", () => {
  it("runs a valid plan and refuses garbage, an empty plan and an unknown payee", () => {
    expect(runPlan('```json\n{"queries":[{"id":"q1","tool":"count","filter":{"payee":"SYNTHCO"}}]}\n```', rows)).toMatchObject({ ok: true, results: [{ args: { filter: { payee: "SALARY SYNTHCO" } }, result: { count: 2 } }] })
    expect(runPlan("I think the answer is R5", rows)).toMatchObject({ ok: false, reason: expect.stringMatching(/invalid plan/) })
    expect(runPlan('{"queries":[]}', rows)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not answer/) })
    expect(runPlan('{"queries":[{"id":"q1","tool":"sum","filter":{"payee":"BLUEGUM MILLS"}}]}', rows)).toMatchObject({ ok: false, reason: expect.stringMatching(/payee/) })
  })
})

describe("checkAnswer and answerQuestion", () => {
  const plan = '{"queries":[{"id":"q1","tool":"sum","filter":{"direction":"out","payee":"KOPANO FRESH FOODS"}}]}'
  it("allows the result's figures and the query ids only", () => {
    const planned = runPlan(plan, rows)
    if (!planned.ok) throw new Error("plan")
    expect(checkAnswer("KOPANO FRESH FOODS was paid R323.45 over 2 payments [q1].", planned.results, [])).toEqual({ ok: true })
    expect(checkAnswer("KOPANO FRESH FOODS was paid R323.46 [q1].", planned.results, []).ok).toBe(false)
    expect(checkAnswer("About R300 [q1].", planned.results, []).ok).toBe(false)
    expect(checkAnswer("R323.45 [q1], which is fine.", planned.results, ["GAMBLING"]).ok).toBe(false)
  })
  it("plans, answers, and stores the queries as the citations", async () => {
    const ask = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce("R323.45 went to KOPANO FRESH FOODS [q1].")
    const out = await answerQuestion({ question: "How much went to Kopano?", rows, raisedFlagCodes: [] }, ask)
    expect(out).toMatchObject({ status: "OK", text: "R323.45 went to KOPANO FRESH FOODS [q1].", citations: [{ id: "q1", tool: "sum", matchedRows: 2 }] })
    // The planner sees masked payees, never the client's name or a raw description.
    expect(ask.mock.calls[0][0]).toContain("KOPANO FRESH FOODS")
    expect(ask.mock.calls[0][0]).not.toContain("TESTER")
    expect(ask.mock.calls[0][0]).not.toContain("Card Purchase")
  })
  it("asks again after a rejected answer, then stores REJECTED with the reason", async () => {
    const ask = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce("Roughly R320 [q1].").mockResolvedValueOnce(plan).mockResolvedValueOnce("R999.00 [q1].")
    const out = await answerQuestion({ question: "How much went to Kopano?", rows, raisedFlagCodes: [] }, ask)
    expect(out).toMatchObject({ status: "REJECTED", rejectReason: 'amount not given: "R999.00"' })
    expect(ask).toHaveBeenCalledTimes(4)
  })
  it("keys an answer by the question and the rows", () => {
    expect(askInputHash("How much?", rows)).toBe(askInputHash("  how   much? ", rows))
    expect(askInputHash("How much?", rows)).not.toBe(askInputHash("How much?", rows.slice(1)))
  })
})
