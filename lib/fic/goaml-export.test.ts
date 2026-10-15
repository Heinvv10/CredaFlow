import { describe, expect, it } from "vitest"
import { buildCtrExport, buildStrExport, csvCell, GOAML_DRAFT_LABEL, xmlEscape } from "./goaml-export"

const at = new Date("2026-10-14T08:00:00.000Z")
const ctr = {
  paymentId: "pay_1", receivedAt: at, amountCents: 5_000_000, loanReference: "LN-TEST-1",
  clientReference: "CL-TEST-1", clientName: "Test Example", clientIdNumber: "0000000000000",
  filingStatus: "UNFILED" as const, fiuReference: null, receiptReversed: false,
}
const str = {
  reference: "STR-20261014-ABCDEF", kind: "SUSPICIOUS_TRANSACTION", status: "OPEN", raisedAt: at,
  clientReference: "CL-TEST-1", clientName: "Test <Example> & Co", clientIdNumber: "0000000000000",
  loanReference: null, paymentAmountCents: null, paymentDate: null,
  grounds: '=HYPERLINK("http://x") cash structured "just under" the threshold', assessmentNote: null,
  fiuReference: null, reportedAt: null,
}

describe("goAML-ready draft exports", () => {
  it("labels every CSV row a draft and converts cents to rand", () => {
    const csv = buildCtrExport([ctr], "csv", at)
    const [head, row] = csv.trim().split("\r\n")
    expect(head.startsWith('"exportStatus","reportType"')).toBe(true)
    expect(row).toContain(`"${GOAML_DRAFT_LABEL}","CTR","pay_1"`)
    expect(row).toContain('"50000.00","ZAR","CASH"')
  })

  it("neutralises spreadsheet formulas and doubles quotes in CSV", () => {
    expect(csvCell("=1+1")).toBe(`"'=1+1"`)
    expect(csvCell("-5")).toBe(`"'-5"`)
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    const csv = buildStrExport([str], "csv", at)
    expect(csv).toContain(`"'=HYPERLINK(""http://x"") cash structured ""just under"" the threshold"`)
  })

  it("escapes XML and says in the document that it is not schema-validated", () => {
    const xml = buildStrExport([str], "xml", at)
    expect(xml).toContain("Not validated against the goAML XML schema")
    expect(xml).toContain(`status="${GOAML_DRAFT_LABEL}"`)
    expect(xml).toContain("<clientName>Test &lt;Example&gt; &amp; Co</clientName>")
    expect(xml).not.toContain("<Example>")
    expect(xmlEscape("a\u0001b")).toBe("ab")
  })

  it("never claims conformance", () => {
    for (const out of [buildCtrExport([ctr], "xml", at), buildCtrExport([ctr], "csv", at)]) {
      expect(out.toLowerCase()).not.toMatch(/schema[- ]valid(ated)?["\s>]|conforms|compliant with goaml/)
    }
  })
})
