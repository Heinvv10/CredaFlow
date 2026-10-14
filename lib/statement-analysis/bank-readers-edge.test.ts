/**
 * The new text readers on the edges review found (PR #72): first rows nothing
 * checks, other banks named in descriptions, figures inside descriptions,
 * missing closing lines, wrapped descriptions and hostile input. Real poppler
 * on synthetic PDFs, or the readers on synthetic page text.
 */
import { describe, expect, it } from "vitest"
import { manualReview } from "@/lib/credit-checks/manual-review"
import { facts } from "@/lib/credit-checks/facts.test-helpers"
import { readAbsa } from "./absa"
import { analyseStatement, type StatementAnalysisResult } from "./analyse"
import { syntheticStatement, type SynthBank } from "./fixtures/dataset"
import { absaLines, buildStatement, discoveryLines, NEW_BANK_PRODUCERS, standardBankLines } from "./fixtures/synthetic-banks"
import { render, type BuildOptions, type SynthStatement } from "./fixtures/synthetic"
import { readStandardBank } from "./standard-bank"
import { nearestColumn, splitFigures } from "./word-table"

const analyse = async (pdf: Uint8Array) => analyseStatement(Buffer.from(pdf), "application/pdf", { allowVlm: false })
const read = async (bank: SynthBank, s: SynthStatement, opts: BuildOptions = {}) => analyse(await buildStatement(bank, s, opts))
const withRow = (bank: SynthBank, description: string, amountCents = -12_500) => {
  const s = syntheticStatement({ bank, start: "2026-07-01" })
  s.transactions = [...s.transactions, { date: "2026-08-10", description, amountCents }].sort((a, b) => a.date.localeCompare(b.date))
  return s
}
const reviewCodes = (r: StatementAnalysisResult) => manualReview(facts({
  payslip: { documentId: "slip", validated: true, matchesClient: true, netPayCents: 1, payDate: "2026-09-25" },
  statements: [{ documentId: "d", analysisId: "a", contentSha256: "s", state: r.status, method: r.method, bank: r.bank, read: r.read, balanceCheck: r.balanceCheck, authenticity: r.authenticity }],
})).map((c) => c.code)

describe("a first row nothing can check (ABSA Transaction History, Discovery)", () => {
  // The client picks the export range, so the salary can be the first row.
  const salaryFirst = (bank: "ABSA" | "DISCOVERY") => {
    const s = syntheticStatement({ bank, start: "2026-07-01" })
    return { ...s, periodStart: "2026-07-25", transactions: s.transactions.filter((t) => t.date >= "2026-07-25") }
  }
  it.each(["ABSA", "DISCOVERY"] as const)("%s: an inflated first-row salary reconciles, so the read goes to a person", async (bank) => {
    const lines = (bank === "ABSA" ? absaLines : discoveryLines)(salaryFirst(bank), { misprint: { index: 0, amountCents: 4_845_000 } })
    const r = await analyse(await render(lines, {}, NEW_BANK_PRODUCERS[bank]))
    expect(r.balanceCheck).toBe("PASS")
    expect(r.authenticity.signals).toContain("OPENING_DERIVED")
    expect(reviewCodes(r)).toContain("FIRST_ROW_UNVERIFIED")
  })

  it("a bank that prints its opening raises no such flag", async () => {
    const r = await read("NEDBANK", syntheticStatement({ bank: "NEDBANK", start: "2026-07-01" }))
    expect(r.authenticity.signals).not.toContain("OPENING_DERIVED")
    expect(reviewCodes(r)).not.toContain("FIRST_ROW_UNVERIFIED")
  })
})

describe("another bank named in a description", () => {
  it.each<[SynthBank, string, string]>([
    ["NEDBANK", "DISCOVERY BANK CC PAYMENT", "NEDBANK"],
    ["ABSA", "TRANSFER TO First National Bank", "ABSA"],
    ["STANDARD_BANK", "PAYMENT TO TymeBank SYNTH", "STANDARD_BANK"],
  ])("%s with %s still reads by its own reader", async (bank, description, expected) => {
    const r = await read(bank, withRow(bank, description))
    expect(r).toMatchObject({ method: "TEXT", bank: expected, balanceCheck: "PASS" })
  })
})

describe("figures and markers inside descriptions do not drop honest rows", () => {
  it.each<[SynthBank, string]>([
    ["NEDBANK", "PAYMENT INV 1,250.00 SYNTH"],
    ["ABSA", "PAYMENT REF absa.co.za SYNTH"],
    // 54 characters: the description column's full width, so "12.50" ends where the money columns begin.
    ["STANDARD_BANK", "SYNTH LONG REFERENCE THAT RUNS ON AND ON TO THE 12.50"],
  ])("%s: %s", async (bank, description) => {
    const s = withRow(bank, description)
    const r = await read(bank, s)
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.transactions).toHaveLength(s.transactions.length)
  })
})

describe("a statement whose closing line is gone is unverified, not derived", () => {
  it("ABSA Transaction History without Balance Carried Forward", async () => {
    const s = syntheticStatement({ bank: "ABSA", start: "2026-07-01" })
    const lines = absaLines(s).map((page) => page.filter((l) => !l.startsWith("Balance Carried Forward")))
    const r = await analyse(await render(lines, {}, NEW_BANK_PRODUCERS.ABSA))
    expect(r.read!.closingBalanceCents).toBeNull()
    expect(r.balanceCheck).toBe("NOT_APPLICABLE")
  })

  it("Standard Bank without its Statement Summary totals (it prints no closing line)", async () => {
    const s = syntheticStatement({ bank: "STANDARD_BANK", start: "2026-07-01" })
    const lines = standardBankLines(s).map((page) => page.filter((l) => !/^\s*(Payments|Deposits)\s+-?R/.test(l)))
    const r = await analyse(await render(lines, {}, NEW_BANK_PRODUCERS.STANDARD_BANK))
    expect(r.read!.closingBalanceCents).toBeNull()
    expect(r.balanceCheck).toBe("NOT_APPLICABLE")
  })
})

describe("descriptions, dates and signs read from page text", () => {
  const absaPage = (rows: string[]) => [[
    "Transaction History (2026-10-01 08:00:00)",
    "T TESTER                                          ABSA",
    "Statement for the Period 2026-07-01 - 2026-07-31",
    "Date         Transaction Description                                     Amount         Balance",
    ...rows,
    "Balance Carried Forward                                                              R900.00",
  ].join("\n")]

  it("ABSA: a wrapped description joins its row; an impossible date drops the row", () => {
    const r = readAbsa(absaPage([
      "2026-07-02   CARD PURCHASE SYNTH                                         -R100.00         R900.00",
      "             CARD NO. 0000",
      "2026-06-31   CARD PURCHASE SYNTH                                         -R100.00         R800.00",
    ]), [[]])!
    expect(r.transactions.map((t) => t.description)).toEqual(["CARD PURCHASE SYNTH CARD NO. 0000"])
  })

  it("ABSA: a description stops growing however many lines wrap under it", () => {
    const wraps = Array.from({ length: 200 }, () => "             SYNTH WRAPPED TEXT LINE")
    const r = readAbsa(absaPage(["2026-07-02   CARD PURCHASE SYNTH                                         -R100.00         R900.00", ...wraps]), [[]])!
    expect(r.transactions[0].description.length).toBeLessThan(400)
  })

  it("Standard Bank: the type line below a row joins its description", () => {
    const r = readStandardBank([[
      "From: 01 Jul 26", "To: 31 Jul 26",
      "  Date          Description                                           Payments        Deposits         Balance",
      "                STATEMENT OPENING BALANCE                                                                1,000.00",
      "  02 Jul 26     SYNTH STORE 0000*0000                                   -100.00                           900.00",
      "                CARD PURCHASE",
      "",
      "Statement Summary",
      "   Payments                           -R100.00",
      "   Deposits                            R0.00",
    ].join("\n")])!
    expect(r.transactions).toEqual([expect.objectContaining({ description: "SYNTH STORE 0000*0000 CARD PURCHASE", amountCents: -10_000 })])
    expect(r.closingBalanceCents).toBe(90_000)
  })

  it("hostile long lines in the ABSA and Standard Bank tables are skipped quickly", () => {
    const long = `2026-07-03   ${"1".repeat(30_000)} -R1.00 R1.00`
    const started = performance.now()
    expect(readAbsa(absaPage([long]), [[]])!.transactions).toEqual([])
    expect(readStandardBank([`From: 01 Jul 26\nTo: 31 Jul 26\n  Date  Description  Payments  Deposits  Balance\n  STATEMENT OPENING BALANCE\n  03 Jul 26 ${"9".repeat(30_000)} -1.00 1.00`])!.transactions).toEqual([])
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe("word-box helpers", () => {
  const w = (text: string, xMin: number, xMax: number) => ({ text, xMin, xMax, yMin: 0 })
  it("does not join figures that are apart, or a run longer than a figure prints as", () => {
    const isFigure = (t: string) => /^\d{1,3}(?: \d{3})*,\d{2}-?$/.test(t)
    expect(splitFigures([w("12", 100, 110), w("345,67-", 140, 170)], isFigure).figures.map((f) => f.text)).toEqual(["345,67-"])
    expect(splitFigures([w("1", 100, 104), w("234,56", 106, 130)], isFigure).figures.map((f) => f.text)).toEqual(["1 234,56"])
    const many = Array.from({ length: 150 }, (_, i) => w(`${"9".repeat(80)}.00`, i * 2, i * 2 + 1.5))
    const started = performance.now()
    expect(splitFigures(many, () => true).figures).toEqual([])
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it("puts a figure under no column when it is far from every one", () => {
    expect(nearestColumn(300, { amount: 400, balance: 500 })).toBeNull()
    expect(nearestColumn(395, { amount: 400, balance: 500 })).toBe("amount")
  })
})

describe("the no-metadata rule", () => {
  it("only sends a metadata-less PDF to a person where the bank's profile accepts no metadata", async () => {
    const bare = { producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: [] as string[] }
    const r = await read("CAPITEC", syntheticStatement({ bank: "CAPITEC", start: "2026-07-01" }))
    expect(reviewCodes({ ...r, authenticity: bare })).not.toContain("AUTHENTICITY_UNCHECKED")
    const d = await read("DISCOVERY", syntheticStatement({ bank: "DISCOVERY", start: "2026-07-01" }))
    expect(reviewCodes({ ...d, authenticity: { ...bare, signals: d.authenticity.signals } })).toContain("AUTHENTICITY_UNCHECKED")
  })
})
