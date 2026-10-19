import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderAnswer } from "@/lib/statement-ai/render"
import type { QueryResult } from "@/lib/statement-ai/ask/tools"
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

type Node = ReturnType<ReactTestRenderer["root"]["findByType"]>
const textOf = (n: Node | string): string => (typeof n === "string" ? n : n.children.map((c) => textOf(c as Node | string)).join(""))
const parts = (r: ReactTestRenderer) => r.root.findAllByProps({ "data-testid": "statement-ai-part" }).filter((n) => typeof n.type === "string").map(textOf)

const rentSum: QueryResult = { id: "q1", tool: "sum", args: { filter: { direction: "out", payee: "SYNTH RENTALS" } }, result: { total: "R19 500.00", rowCount: 3, direction: "out" }, matchedRows: 3, rows: [{ ref: "S1-R5", date: "2026-07-27", payee: "SYNTH RENTALS", amount: "-R6 500.00" }] }
const largest: QueryResult = {
  id: "q2", tool: "list", args: { filter: { direction: "out" }, limit: 2, order: "largest" }, matchedRows: 15,
  result: [{ ref: "S1-R5", date: "2026-07-27", payee: "SYNTH RENTALS", amount: "R6 500.00", direction: "out" }, { ref: "S1-R2", date: "2026-07-12", payee: "HOLLYWOODBETS", amount: "R1 500.00", direction: "out" }],
  rows: [],
}
const answered = (id: string, question: string, results: QueryResult[], over: Record<string, unknown> = {}) =>
  output({ id, kind: "ANSWER", question, text: renderAnswer(results), citations: results, ...over })
const payloadWith = (answers: unknown[]) => ({ summary: output({}), answers, pending: 0, noStatements: false, modelAvailable: true })

describe("StatementAiCard", () => {
  it("renders nothing while the lender has Statement AI off (404)", async () => {
    const { r } = await render(404, { error: "Statement AI is not enabled" })
    expect(r.toJSON()).toBeNull()
  })

  it("shows an OK summary, marks a stale one, and leaves the input hash out", async () => {
    const { html } = await render(200, { summary: output({ stale: true }), answers: [], pending: 1, noStatements: false, modelAvailable: true })
    expect(html).toContain("GAMBLING was raised.")
    expect(html).not.toContain("abcdef01")
    expect(html).toContain("stale: the statement facts changed since")
    expect(html).toContain("Advisory: the credit checks decide")
  })

  it("shows 'unavailable' for a rejected output and never its text", async () => {
    const { html } = await render(200, {
      summary: output({ status: "REJECTED", text: null }),
      answers: [], pending: 0, noStatements: false, modelAvailable: true,
    })
    expect(html).toContain("Summary unavailable.")
  })

  // Each flag's explanation is in its own row of the credit checks panel: the card says nothing about it again.
  it("has no flag explanations, even from a payload that still carries them", async () => {
    const rows = [{ ref: "S1-R2", date: "2026-07-12", payee: "HOLLYWOODBETS", amount: "-R1 500.00" }]
    const { html } = await render(200, {
      summary: output({}),
      explanations: [output({ id: "o2", kind: "FLAG_EXPLANATION", flagCode: "GAMBLING", text: "Betting is compared with income.", citations: { facts: { evidenceRows: rows } } })],
      answers: [], pending: 0, noStatements: false, modelAvailable: true,
    })
    expect(html).not.toContain("Flags explained")
    expect(html).not.toContain("Betting is compared with income.")
    expect(html).not.toContain("HOLLYWOODBETS")
  })

  it("shows an answer with how it was computed, and the ask box", async () => {
    const answer = answered("o3", "How much went to SYNTH RENTALS?", [rentSum])
    const payload = payloadWith([answer, output({ id: "o4", kind: "ANSWER", question: "Pending?", status: "PENDING", text: null, citations: null })])
    const { html, r: shown } = await render(200, payload)
    expect(parts(shown)).toEqual(['Total for money out to "SYNTH RENTALS": R19 500.00, from 3 rows.'])
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
    const { r } = await render(200, { summary: output({ text }), answers: [], pending: 0, noStatements: false, modelAvailable: true })
    const items = r.root.findAllByType("li").map((li) => li.children.filter((c) => typeof c === "string").join(""))
    expect(items).toEqual(["Over the period, money in was R100.00 and money out was R50.00.", "By month:", "2026-07 money in R60.00, money out R20.00", "2026-08 money in R40.00, money out R30.00"])
  })

  it("shows a breakdown as a table, and drops a failed answer once the same question is answered", async () => {
    const answer = output({
      id: "o5", kind: "ANSWER", question: "Money in each month?", text: "[q1] By month for money in: 2026-07 R18 450.00 (1 row); 2026-08 R18 450.00 (1 row).",
      citations: [{ id: "q1", tool: "groupByMonth", args: { filter: { direction: "in" }, measure: "sum" }, result: [{ month: "2026-07", total: "R18 450.00", rowCount: 1, direction: "in" }, { month: "2026-08", total: "R18 450.00", rowCount: 1, direction: "in" }], matchedRows: 2, rows: [] }],
    })
    const failed = output({ id: "o6", kind: "ANSWER", question: "money in each month? ", status: "REJECTED", text: null, citations: null })
    const { r } = await render(200, { summary: output({}), answers: [answer, failed], pending: 0, noStatements: false, modelAvailable: true })
    const cells = r.root.findAllByType("td").map((td) => td.children.join(""))
    expect(cells).toEqual(["2026-07", "R18 450.00 in", "1", "2026-08", "R18 450.00 in", "1"])
    expect(r.root.findAllByProps({ "data-testid": "statement-ai-answer" })).toHaveLength(1)
    expect(JSON.stringify(r.toJSON())).not.toContain("Answer unavailable.")
  })

  it("labels each part of a two-query answer, and shows a list as a table with its match count", async () => {
    const { r } = await render(200, payloadWith([answered("o7", "Rent, and the 2 largest debits?", [rentSum, largest])]))
    expect(parts(r)).toEqual([
      'q1Total for money out to "SYNTH RENTALS": R19 500.00, from 3 rows.',
      expect.stringMatching(/^q2Rows for money out, largest amount at the top:.*SYNTH RENTALS.*R6 500.00 out.*15 rows match in all\.$/),
    ])
    expect(textOf(r.root.findAllByProps({ "data-testid": "statement-ai-query" }).filter((n) => typeof n.type === "string")[1])).toContain("Listed up to 2 rows, largest first, of money out: 15 rows matched.")
  })

  it("shows text that is not exactly render.ts's labelled form as written, never cut at a label", async () => {
    const { r } = await render(200, payloadWith([output({ id: "o8", kind: "ANSWER", question: "Rent?", text: "R19 500.00 [q1].", citations: [rentSum] })]))
    expect(parts(r)).toEqual([])
    expect(JSON.stringify(r.toJSON())).toContain("R19 500.00 [q1].")
    // Labelled, but not for these queries: q2's sentence must not be shown as q1's part.
    const swapped = renderAnswer([{ ...largest, id: "q1" }, { ...rentSum, id: "q3" }])
    const { r: other } = await render(200, payloadWith([output({ id: "o11", kind: "ANSWER", question: "Rent?", text: swapped, citations: [rentSum, { ...largest, id: "q2" }] })]))
    expect(parts(other)).toEqual([])
    expect(JSON.stringify(other.toJSON())).toContain("[q3]")
  })

  it("keeps a failed answer that is newer than the answered one", async () => {
    const failed = output({ id: "o9", kind: "ANSWER", question: "Rent?", status: "REJECTED", text: null, citations: null })
    const { r } = await render(200, payloadWith([failed, answered("o10", "Rent?", [rentSum])]))
    expect(r.root.findAllByProps({ "data-testid": "statement-ai-answer" }).filter((n) => typeof n.type === "string")).toHaveLength(2)
    expect(JSON.stringify(r.toJSON())).toContain("Answer unavailable.")
  })
})
