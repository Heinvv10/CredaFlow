import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StatementAiCard } from "./StatementAiCard"

const output = (over: Record<string, unknown>) => ({
  id: "o1", kind: "SUMMARY", flagCode: null, status: "OK", text: "GAMBLING was raised.", inputHash: "abcdef0123456789",
  promptVersion: "summary-p1", createdAt: "2026-10-17T10:00:00.000Z", stale: false, citations: { facts: {} }, ...over,
})

async function render(status: number, body: unknown): Promise<{ html: string; r: ReactTestRenderer }> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })))
  let r: ReactTestRenderer | undefined
  await act(async () => { r = create(<StatementAiCard applicationId="app-1" />) })
  await act(async () => { await new Promise((res) => setTimeout(res, 0)) })
  return { html: JSON.stringify(r!.toJSON()), r: r! }
}

afterEach(() => vi.unstubAllGlobals())

describe("StatementAiCard", () => {
  it("renders nothing while the lender has Statement AI off (404)", async () => {
    const { r } = await render(404, { error: "Statement AI is not enabled" })
    expect(r.toJSON()).toBeNull()
  })

  it("shows an OK summary, marks a stale one, and leaves the input hash out", async () => {
    const { html } = await render(200, { summary: output({ stale: true }), explanations: [], answers: [], pending: 1, noStatements: false, modelAvailable: true })
    expect(html).toContain("GAMBLING was raised.")
    expect(html).not.toContain("abcdef01")
    expect(html).toContain("stale: the statement facts changed since")
    expect(html).toContain("Advisory: the credit checks decide")
  })

  it("shows 'unavailable' for a rejected output and never its text", async () => {
    const { html } = await render(200, {
      summary: output({ status: "REJECTED", text: null }),
      explanations: [output({ id: "o2", kind: "FLAG_EXPLANATION", flagCode: "GAMBLING", status: "REJECTED", text: null })],
      answers: [], pending: 0, noStatements: false, modelAvailable: true,
    })
    expect(html).toContain("Summary unavailable.")
    expect(html).toContain("Explanation unavailable.")
  })

  it("lists the rows an explanation cites", async () => {
    const rows = [{ ref: "S1-R2", date: "2026-07-12", payee: "HOLLYWOODBETS", amount: "-R1 500.00" }]
    const { html } = await render(200, {
      summary: output({}),
      explanations: [output({ id: "o2", kind: "FLAG_EXPLANATION", flagCode: "GAMBLING", text: "GAMBLING: see S1-R2.", citations: { facts: { evidenceRows: rows } } })],
      answers: [], pending: 0, noStatements: false, modelAvailable: true,
    })
    expect(html).toContain("S1-R2")
    expect(html).toContain("HOLLYWOODBETS")
  })

  it("shows an answer with how it was computed, and the ask box", async () => {
    const answer = output({
      id: "o3", kind: "ANSWER", question: "How much went to SYNTH RENTALS?", text: "R19 500.00 [q1].",
      citations: [{ id: "q1", tool: "sum", args: { filter: { direction: "out", payee: "SYNTH RENTALS" } }, result: { total: "R19 500.00", rowCount: 3 }, matchedRows: 3, rows: [{ ref: "S1-R5", date: "2026-07-27", payee: "SYNTH RENTALS", amount: "-R6 500.00" }] }],
    })
    const payload = { summary: output({}), explanations: [], answers: [answer, output({ id: "o4", kind: "ANSWER", question: "Pending?", status: "PENDING", text: null, citations: null })], pending: 0, noStatements: false, modelAvailable: true }
    const { html } = await render(200, payload)
    expect(html).toContain("How much went to SYNTH RENTALS?")
    expect(html).toContain("How this was computed")
    expect(html).toContain("S1-R5")
    expect(html).toContain("R6 500.00 out")
    expect(html).not.toContain("-R6 500.00")
    expect(html).toContain("Added up")
    expect(html).not.toContain("rowCount")
    expect(html).not.toContain("[q1]")
    expect(html).toContain("Working it out…")
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    let r: ReactTestRenderer | undefined
    await act(async () => { r = create(<StatementAiCard applicationId="app-1" />) })
    await act(async () => { await new Promise((res) => setTimeout(res, 0)) })
    expect(JSON.stringify(r!.toJSON())).toContain("statement-ai-question")
  })

  it("lists a summary one claim a line, a list claim as sub-items", async () => {
    const text = "Over the period, money in was R100.00 and money out was R50.00.\nBy month: 2026-07 money in R60.00, money out R20.00; 2026-08 money in R40.00, money out R30.00."
    const { r } = await render(200, { summary: output({ text }), explanations: [], answers: [], pending: 0, noStatements: false, modelAvailable: true })
    const items = r.root.findAllByType("li").map((li) => li.children.filter((c) => typeof c === "string").join(""))
    expect(items).toEqual(["Over the period, money in was R100.00 and money out was R50.00.", "By month:", "2026-07 money in R60.00, money out R20.00", "2026-08 money in R40.00, money out R30.00"])
  })

  it("shows a breakdown as a table, and drops a failed answer once the same question is answered", async () => {
    const answer = output({
      id: "o5", kind: "ANSWER", question: "Money in each month?", text: "[q1] By month for money in: 2026-07 R18 450.00 (1 row); 2026-08 R18 450.00 (1 row).",
      citations: [{ id: "q1", tool: "groupByMonth", args: { filter: { direction: "in" }, measure: "sum" }, result: [{ month: "2026-07", total: "R18 450.00", rowCount: 1, direction: "in" }, { month: "2026-08", total: "R18 450.00", rowCount: 1, direction: "in" }], matchedRows: 2, rows: [] }],
    })
    const failed = output({ id: "o6", kind: "ANSWER", question: "money in each month? ", status: "REJECTED", text: null, citations: null })
    const { r } = await render(200, { summary: output({}), explanations: [], answers: [answer, failed], pending: 0, noStatements: false, modelAvailable: true })
    const cells = r.root.findAllByType("td").map((td) => td.children.join(""))
    expect(cells).toEqual(["2026-07", "R18 450.00 in", "1", "2026-08", "R18 450.00 in", "1"])
    expect(r.root.findAllByProps({ "data-testid": "statement-ai-answer" })).toHaveLength(1)
    expect(JSON.stringify(r.toJSON())).not.toContain("Answer unavailable.")
  })
})
