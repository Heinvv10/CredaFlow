import { describe, it, expect } from "vitest"
import { parseStatementCsv } from "./parse"

// ABSA "Transaction History" layout (every value below is invented): 4 columns `Date,Description,Amount,Balance`, dates as YYYYMMDD,
// a single signed period-decimal Amount, and the reference embedded in the
// free-text Description (quoted when it contains commas).
const CSV = [
  "Date,Description,Amount,Balance",
  "20260707,DIGITAL TRANSF CR 12345678-1234-0001 ABSA BANK TST to Acme Store,800.00,10800.00",
  '20260707,"POS PURCHASE                  (      4,60 ) (EFFEC 01072026) DL Acme Demo Shop CARD NO.  0000",-123.45,10676.55',
  "",
  "20260708,DIGITAL TRANSF CR LN-0099 loan repayment,1500.00,12176.55",
].join("\n")

describe("parseStatementCsv", () => {
  it("parses the real ABSA 4-column layout into signed cents", () => {
    const lines = parseStatementCsv(CSV)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({
      amountCents: 80000,
      direction: "CREDIT",
      rawReference: "DIGITAL TRANSF CR 12345678-1234-0001 ABSA BANK TST to Acme Store",
      counterparty: null,
      balanceCents: 1080000,
    })
    // Quoted description with an internal comma ("4,60") must not shift columns.
    expect(lines[1]).toMatchObject({ amountCents: -12345, direction: "DEBIT" })
    expect(lines[1].rawReference).toContain("POS PURCHASE")
    // A loan number typed into the transfer reference lands in rawReference.
    expect(lines[2]).toMatchObject({ amountCents: 150000, direction: "CREDIT" })
    expect(lines[2].rawReference).toContain("LN-0099")
  })

  it("parses YYYYMMDD dates (and still accepts ISO + DD/MM/YYYY)", () => {
    const lines = parseStatementCsv(CSV)
    expect(lines[0].postedDate.toISOString().slice(0, 10)).toBe("2026-07-07")

    const alt = [
      "Date,Description,Amount,Balance",
      "2026-07-10,EFT,1500.00,25000.00",
      "12/07/2026,POS,-250.50,24690.50",
    ].join("\n")
    const altLines = parseStatementCsv(alt)
    expect(altLines[0].postedDate.toISOString().slice(0, 10)).toBe("2026-07-10")
    expect(altLines[1].postedDate.toISOString().slice(0, 10)).toBe("2026-07-12")
  })

  it("throws on a malformed amount rather than dropping the row", () => {
    const bad = "Date,Description,Amount,Balance\n20260710,X,notanumber,1.00"
    expect(() => parseStatementCsv(bad)).toThrow(/amount/i)
  })

  it("degrades an unparseable balance to null without aborting later rows", () => {
    const csv = [
      "Date,Description,Amount,Balance",
      "20260710,EFT credit,150.00,-",
      "20260711,EFT credit,200.00,500.00",
    ].join("\n")
    const lines = parseStatementCsv(csv)
    expect(lines).toHaveLength(2)
    expect(lines[0].balanceCents).toBeNull()
    expect(lines[1]).toMatchObject({ amountCents: 20000, balanceCents: 50000 })
  })

  it("throws on a malformed date (fail loud)", () => {
    const bad = "Date,Description,Amount,Balance\nnotadate,X,1.00,1.00"
    expect(() => parseStatementCsv(bad)).toThrow(/date/i)
  })
})
