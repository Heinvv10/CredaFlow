/**
 * Review round 3 on #72: deleted openings, and v1 readers' (Capitec, FNB)
 * table markers matched inside descriptions. Synthetic PDFs, real poppler.
 */
import { describe, expect, it } from "vitest"
import { analyseStatement } from "./analyse"
import { syntheticStatement, type SynthBank } from "./fixtures/dataset"
import { absaLines, buildStatement, nedbankLines, NEW_BANK_PRODUCERS } from "./fixtures/synthetic-banks"
import { render, type SynthStatement } from "./fixtures/synthetic"

const analyse = async (pdf: Uint8Array) => analyseStatement(Buffer.from(pdf), "application/pdf", { allowVlm: false })
const withRow = (bank: SynthBank, description: string) => {
  const s: SynthStatement = syntheticStatement({ bank, start: "2026-07-01" })
  s.transactions = [...s.transactions, { date: "2026-08-10", description, amountCents: -12_500 }].sort((a, b) => a.date.localeCompare(b.date))
  return s
}

describe("a deleted opening balance", () => {
  it("still leaves every printed balance checked: a misprinted row fails", async () => {
    const s = syntheticStatement({ bank: "NEDBANK", start: "2026-07-01" })
    const lines = nedbankLines(s, { misprint: { index: 3, amountCents: -1_000 } })
      // The summary's "Opening balance  R…" line; the table's own opening row stays (it prints no R).
      .map((page) => page.filter((l) => !/^\s*Opening balance\s+-?R/.test(l)))
    const r = await analyse(await render(lines, {}, NEW_BANK_PRODUCERS.NEDBANK))
    expect(r.read!.openingBalanceCents).toBeNull()
    expect(r.balanceCheck).toBe("FAIL")
  })
})

describe("v1 readers: table markers inside descriptions do not drop honest rows", () => {
  it.each<[SynthBank, string]>([
    ["CAPITEC", "Payment Received: Includes VAT REF"],
    ["CAPITEC", "Payment To: Client Care Centre SYNTH"],
    ["FNB", "Payment Date Amount Balance REF"],
  ])("%s: %s", async (bank, description) => {
    const s = withRow(bank, description)
    const r = await analyse(await buildStatement(bank, s))
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.transactions).toHaveLength(s.transactions.length)
  })
})

describe("ABSA's carried-forward balance", () => {
  it("is read only from its own line, not from a description that names it", async () => {
    const s = withRow("ABSA", "Balance Carried Forward SYNTH")
    const lines = absaLines(s).map((page) => page.filter((l) => !l.startsWith("Balance Carried Forward")))
    const r = await analyse(await render(lines, {}, NEW_BANK_PRODUCERS.ABSA))
    expect(r.read!.closingBalanceCents).toBeNull()
  })
})
