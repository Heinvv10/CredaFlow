import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { computeInsights } from "@/lib/statement-analysis/insights"
import { StatementInsightsPanel } from "./StatementInsightsPanel"

const rows = [
  { date: "2026-07-02", description: "Card Purchase: SYNTH ZOLA TRADING", amountCents: -10_000, balanceCents: null, page: 1 },
  { date: "2026-07-03", description: "Card Purchase: SHOPRITE", amountCents: -5_000, balanceCents: null, page: 1 },
]
const read = { accountHolderName: "T TESTER", accountNumberLast4: "0001", periodStart: "2026-07-01", periodEnd: "2026-07-30", openingBalanceCents: 100_000, closingBalanceCents: null, transactions: rows }
const payload = (modelLabels: unknown) => ({
  ...computeInsights([{ documentId: "doc-1", bank: "CAPITEC", balanceCheck: "PASS", read, modelLabels }], { clientName: "Thabo Tester", declaredExpensesCents: 100_000 }),
  unreadStatements: 0,
})

async function render(body: unknown): Promise<string> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
  let r: ReactTestRenderer | undefined
  await act(async () => { r = create(<StatementInsightsPanel applicationId="app-1" />) })
  await act(async () => { await new Promise((res) => setTimeout(res, 0)) })
  return JSON.stringify(r!.toJSON())
}

afterEach(() => vi.unstubAllGlobals())

describe("StatementInsightsPanel: model labels", () => {
  it("names the model-assigned rows for the officer to check", async () => {
    const html = await render(payload({ "SYNTH ZOLA TRADING": "FOOD" }))
    expect(html).toContain("Model-assigned: ")
    expect(html).toContain("Card Purchase: SYNTH ZOLA TRADING")
    expect(html).not.toContain("has not labelled")
  })

  it("says when no model is configured, instead of waiting for labels", async () => {
    const html = await render({ ...payload(null), modelLabelsEnabled: false })
    expect(html).toContain("No local model is configured")
    expect(html).not.toContain("has not labelled")
  })

  it("says when the model has not labelled a statement", async () => {
    const html = await render(payload(null))
    expect(html).toContain("has not labelled")
    expect(html).not.toContain("Model-assigned: ")
  })
})
