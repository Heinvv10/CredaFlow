import { describe, expect, it } from "vitest"
import { parseMappingInput } from "./accounts"
import { cell, linesDigest, rands, renderCsv, type StoredLine } from "./csv"

const lines: StoredLine[] = [
  { lineNo: 2, postingDate: "2026-09-10", accountCode: "1100", taxCode: null, debitCents: 0, creditCents: 50_005, reference: "LN-1", description: "Receipt on LN-1", eventKey: "payment:p1" },
  { lineNo: 1, postingDate: "2026-09-10", accountCode: "1000", taxCode: "NONE", debitCents: 50_005, creditCents: 0, reference: "LN-1", description: "Receipt on LN-1", eventKey: "payment:p1" },
]

describe("mapping input", () => {
  it("allows VAT-inclusive only on fee income, and never together with a tax code", () => {
    expect(parseMappingInput({ mappings: [{ role: "FEE_INCOME", accountCode: "4010", vatInclusive: true }] })).toMatchObject({ ok: true })
    expect(parseMappingInput({ mappings: [{ role: "INTEREST_INCOME", accountCode: "4000", vatInclusive: true }] })).toMatchObject({ ok: false, error: expect.stringContaining("only fee income") })
    expect(parseMappingInput({ mappings: [{ role: "FEE_INCOME", accountCode: "4010", vatInclusive: true, taxCode: "OUTPUT" }] })).toMatchObject({ ok: false, error: expect.stringContaining("twice") })
  })
})

describe("journal CSVs", () => {
  it("renders the generic layout in line order with rand amounts", () => {
    expect(renderCsv("generic", lines)).toBe(
      "Date,Account,Debit,Credit,Reference,Description\r\n" +
      '2026-09-10,"1000",500.05,,"LN-1","Receipt on LN-1"\r\n' +
      '2026-09-10,"1100",,500.05,"LN-1","Receipt on LN-1"\r\n',
    )
  })

  it("renders the Sage-style layout with dd/mm/yyyy and a tax code column", () => {
    expect(renderCsv("sage", lines).split("\r\n")[1]).toBe('10/09/2026,"LN-1","1000","Receipt on LN-1","NONE",500.05,')
  })

  it("is byte-identical for the same lines, whatever order they are read in", () => {
    expect(renderCsv("generic", [...lines].reverse())).toBe(renderCsv("generic", lines))
    expect(linesDigest([...lines].reverse())).toBe(linesDigest(lines))
  })

  it("changes the digest when any stored figure changes", () => {
    expect(linesDigest([{ ...lines[0], creditCents: 50_006 }, lines[1]])).not.toBe(linesDigest(lines))
  })

  it("neutralises spreadsheet formulas and quotes", () => {
    expect(cell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(rands(7)).toBe("0.07")
    expect(rands(0)).toBe("")
  })
})
