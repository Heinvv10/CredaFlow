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
import { absaEstatementLines, absaLines, buildStatement, discoveryLines, nedbankLines, NEW_BANK_PRODUCERS, standardBankLines } from "./fixtures/synthetic-banks"
import { fnbLines, GENUINE_PRODUCERS, render, type BuildOptions, type SynthStatement } from "./fixtures/synthetic"
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

describe("guards the second review found untested", () => {
  it("Discovery's last row is flagged too: its closing is that row's balance", async () => {
    const r = await read("DISCOVERY", syntheticStatement({ bank: "DISCOVERY", start: "2026-07-01" }))
    expect(r.authenticity.signals).toEqual(expect.arrayContaining(["OPENING_DERIVED", "CLOSING_DERIVED"]))
    expect(reviewCodes(r)).toEqual(expect.arrayContaining(["FIRST_ROW_UNVERIFIED", "LAST_ROW_UNVERIFIED"]))
    const absa = await read("ABSA", syntheticStatement({ bank: "ABSA", start: "2026-07-01" }))
    expect(reviewCodes(absa)).not.toContain("LAST_ROW_UNVERIFIED")
  })

  it("Standard Bank's closing is opening + deposits + payments, payments negative", () => {
    const page = (payments: string) => [[
      "From: 01 Jul 26", "To: 31 Jul 26",
      "  Date          Description                                           Payments        Deposits         Balance",
      "                STATEMENT OPENING BALANCE                                                                1,000.00",
      "  02 Jul 26     SYNTH STORE                                             -100.00                           900.00",
      "  03 Jul 26     SYNTH PAYER                                                             50.00             950.00",
      "Statement Summary", `   Payments                           ${payments}`, "   Deposits                            R50.00",
    ].join("\n")]
    expect(readStandardBank(page("-R100.00"))!.closingBalanceCents).toBe(95_000)
  })

  it("Standard Bank: a reference carrying the opening label cannot stand in for a missing opening", () => {
    const r = readStandardBank([[
      "From: 01 Jul 26", "To: 31 Jul 26",
      "  Date          Description                                           Payments        Deposits         Balance",
      "  02 Jul 26     STATEMENT OPENING BALANCE                               -100.00                           900.00",
    ].join("\n")])!
    expect(r.openingBalanceCents).toBeNull()
  })

  it("Discovery: a debit printed with a trailing minus is still a debit", async () => {
    const s = syntheticStatement({ bank: "DISCOVERY", start: "2026-07-01" })
    const lines = discoveryLines(s).map((page) => page.map((l) => l.replace("R 845.50 ", "R 845.50-")))
    const r = await analyse(await render(lines, {}, NEW_BANK_PRODUCERS.DISCOVERY))
    expect(r.read!.transactions[0].amountCents).toBe(-84_550)
  })

  it("Nedbank: a description that reads like the header does not move the columns", async () => {
    const r = await read("NEDBANK", withRow("NEDBANK", "Date Description Debits Credits Balance"))
    expect(r.balanceCheck).toBe("PASS")
  })

  it("splitFigures joins at most five words into one figure", () => {
    const w = (text: string, i: number) => ({ text, xMin: i * 10, xMax: i * 10 + 8, yMin: 0 })
    const words = ["1", "2", "3", "4", "5", "6", "000.00"].map(w)
    expect(splitFigures(words, (t) => /^[\d ]+\.\d{2}$/.test(t)).figures.map((f) => f.text)).toEqual(["3 4 5 6 000.00"])
  })
})

describe("the second breaker's attacks", () => {
  // Salary +6,550 and the next debit +6,550, every balance left as printed, the salary's balance blanked.
  const compensated = (lines: string[][], blank: (l: string) => string, rent: [string, string] = [" 6,500.00", "13,050.00"]) => lines.map((page) => {
    let salary = false
    let rentDone = false
    return page.map((l) => {
      if (!salary && /SALARY/.test(l) && l.includes("18,450.00")) {
        salary = true
        return blank(l.replace("18,450.00", "25,000.00"))
      }
      if (salary && !rentDone && /RENTALS/.test(l) && l.includes(rent[0])) {
        rentDone = true
        return l.replace(rent[0], rent[1])
      }
      return l
    })
  })
  const dropBalance = (l: string) => l.slice(0, l.length - 16).trimEnd()

  it.each<["NEDBANK" | "DISCOVERY", (s: SynthStatement) => string[][], [string, string]]>([
    ["NEDBANK", (s) => nedbankLines(s), [" 6,500.00", "13,050.00"]],
    // Discovery prints "R 6,500.00": keep the "R " so the edited figure still reads.
    ["DISCOVERY", (s) => discoveryLines(s), ["  R 6,500.00", "R 13,050.00"]],
  ])("%s: a row with its balance blanked is not read, so the edit breaks the arithmetic", async (bank, lines, rent) => {
    const r = await analyse(await render(compensated(lines(syntheticStatement({ bank, start: "2026-07-01" })), dropBalance, rent), {}, NEW_BANK_PRODUCERS[bank]))
    expect(r.balanceCheck).toBe("FAIL")
  })

  it("FNB: the same edit fails too", async () => {
    const s = syntheticStatement({ bank: "FNB", start: "2026-07-01" })
    const r = await analyse(await render(compensated(fnbLines(s), (l) => l.slice(0, l.length - 18).trimEnd()), {}, GENUINE_PRODUCERS.FNB))
    expect(r.balanceCheck).toBe("FAIL")
  })

  it("ABSA eStatement: rows without a balance send the statement to a person", async () => {
    const s = syntheticStatement({ bank: "ABSA_ESTATEMENT", start: "2026-07-01" })
    // eStatement figures print as "18 450,00": blank the first salary line's balance.
    let done = false
    const lines = absaEstatementLines(s).map((page) => page.map((l) => (!done && /SALARY/.test(l) && /,\d{2}\s*$/.test(l) && (done = true) ? dropBalance(l) : l)))
    const r = await analyse(await render(lines, {}, NEW_BANK_PRODUCERS.ABSA_ESTATEMENT))
    expect(r.authenticity.signals).toContain("ROWS_WITHOUT_BALANCE")
    expect(reviewCodes(r)).toContain("ROWS_UNCHECKED")
  })

  it("a deleted closing line still leaves every printed balance checked", async () => {
    const s = syntheticStatement({ bank: "NEDBANK", start: "2026-07-01" })
    const lines = nedbankLines(s, { misprint: { index: 3, amountCents: -1_000 } }).map((page) => page.filter((l) => !l.includes("Closing balance")))
    const r = await analyse(await render(lines, {}, NEW_BANK_PRODUCERS.NEDBANK))
    expect(r.read!.closingBalanceCents).toBeNull()
    expect(r.balanceCheck).toBe("FAIL")
  })

  it.each<[SynthBank, string]>([
    ["ABSA", "REF Page 1 of 2 SYNTH"],
    ["ABSA", "Balance Carried Forward SYNTH"],
    ["STANDARD_BANK", "The Standard Bank of South Africa Limited"],
  ])("%s: a description saying %s does not end the table", async (bank, description) => {
    const s = withRow(bank, description)
    const r = await read(bank, s)
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.transactions).toHaveLength(s.transactions.length)
  })
})
