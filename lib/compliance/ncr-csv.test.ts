import { describe, it, expect } from "vitest"
import { buildNcrCsv, csvEscape, ncrBasisLabel, NCR_CSV_HEADER } from "./ncr-csv"
import type { NcrReturnData, NcrReturnLine } from "./ncr-return"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const fmtDate = (d: Date | string) =>
  new Date(d).toISOString().slice(0, 10)
const fmtDateTime = (d: Date | string) => new Date(d).toISOString()

const GENERATED = new Date("2026-08-16T10:00:00Z")

function line(over: Partial<NcrReturnLine> = {}): NcrReturnLine {
  return {
    key: "par30",
    label: "PAR30 — 30+ days past due",
    count: 6,
    value: 123456, // cents
    basis: "POSITION",
    ...over,
  }
}

function data(over: Partial<NcrReturnData> = {}): NcrReturnData {
  return {
    quarter: "2026-Q2",
    periodStart: new Date("2026-03-31T22:00:00Z"),
    periodEnd: new Date("2026-06-30T21:59:59.999Z"),
    quarterOpen: false,
    ncrNumber: ACME_LENDER.ncrNumber,
    collectibleBook: { count: 20, value: 1_000_00 },
    lines: [line()],
    submittedAt: null,
    submittedByName: null,
    filed: null,
    positionIsStale: false,
    filedSnapshotUnreadable: false,
    ...over,
  }
}

const build = (d: NcrReturnData) =>
  buildNcrCsv({
    data: d,
    quarterLabel: "Q2 2026",
    generatedAt: GENERATED,
    formatDate: fmtDate,
    formatDateTime: fmtDateTime,
  })

describe("csvEscape", () => {
  it("quotes and doubles embedded quotes", () => {
    expect(csvEscape('a "b" c')).toBe('"a ""b"" c"')
  })

  it("keeps a comma inside one field", () => {
    const out = csvEscape("Arrears, current")
    expect(out).toBe('"Arrears, current"')
    // One field: the value is wrapped, so the comma cannot split a column.
    expect(out.startsWith('"') && out.endsWith('"')).toBe(true)
  })

  it("survives a newline in a note", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"')
  })
})

describe("buildNcrCsv", () => {
  it("states money in rands, converted from cents", () => {
    // 123456 cents = R1,234.56. A missing /100 would print 123456.00.
    const csv = build(data())
    expect(csv).toContain("1234.56")
    expect(csv).not.toContain("123456.00")
  })

  it("formats a zero value as 0.00, not as blank", () => {
    const csv = build(data({ lines: [line({ value: 0 })] }))
    expect(csv.split("\n")[1]).toContain(",0.00,")
  })

  it("leaves a null value and a null count empty rather than printing 0", () => {
    // "Matters referred to attorney" has no monetary dimension; a 0.00 there
    // would read as "no money" rather than "not applicable".
    const csv = build(data({ lines: [line({ value: null, count: null })] }))
    const row = csv.split("\n")[1]
    expect(row).toBe('"PAR30 — 30+ days past due",,,,Position at export,""')
  })

  it("emits the header once, first", () => {
    const csv = build(data())
    expect(csv.split("\n")[0]).toBe(NCR_CSV_HEADER)
    expect(csv.split("\n").filter((l) => l === NCR_CSV_HEADER)).toHaveLength(1)
  })

  it("carries the basis note so a value and a percentage stay explicable", () => {
    const csv = build(data({
      lines: [line({ note: "Value is the arrears balance; the percentage is exposure at risk." })],
    }))
    expect(csv).toContain('"Value is the arrears balance; the percentage is exposure at risk."')
  })

  it("renders the percentage to one decimal", () => {
    const csv = build(data({ lines: [line({ percentOfBook: 12.3456 })] }))
    expect(csv).toContain(",12.3,")
  })

  it("labels an in-quarter line as In-quarter", () => {
    const csv = build(data({ lines: [line({ basis: "PERIOD" })] }))
    expect(csv).toContain("In-quarter")
    expect(csv).not.toContain("Position at export")
  })

  it("exports the FILED figures for a submitted quarter, not the live book", () => {
    const csv = build(data({
      lines: [line({ value: 999_99, label: "LIVE" })],
      filed: {
        collectibleBook: { count: 3, value: 111_00 },
        lines: [line({ value: 111_11, label: "AS FILED" })],
      },
      submittedAt: new Date("2026-07-05T08:00:00Z"),
    }))
    expect(csv).toContain("AS FILED")
    expect(csv).not.toContain("LIVE")
    expect(csv).toContain("111.11")
    expect(csv).not.toContain("999.99")
  })

  it("states in the footer that a submitted quarter is as filed, with the date", () => {
    const csv = build(data({
      filed: { collectibleBook: { count: 1, value: 1 }, lines: [line()] },
      submittedAt: new Date("2026-07-05T08:00:00Z"),
    }))
    expect(csv).toContain('"Position basis","Figures as filed on 2026-07-05"')
    expect(csv).toContain("Position as filed")
  })

  it("warns in the footer when a closed quarter has nothing filed", () => {
    const csv = build(data({ positionIsStale: true }))
    expect(csv).toContain('"Position lines reflect the book today, NOT the quarter end"')
  })

  it("states the generation basis when the quarter is still open", () => {
    const csv = build(data({ quarterOpen: true, positionIsStale: false }))
    expect(csv).toContain('"Position lines reflect the book at generation"')
  })

  it("carries the registration number, quarter and period in the footer", () => {
    const csv = build(data())
    expect(csv).toContain(`"NCR Registration Number","${ACME_LENDER.ncrNumber}"`)
    expect(csv).toContain('"Quarter","Q2 2026"')
    expect(csv).toContain('"Period","2026-03-31 - 2026-06-30"')
    expect(csv).toContain(`"Generated","${GENERATED.toISOString()}"`)
  })

  it("keeps every data row at the header's column count", () => {
    const csv = build(data({
      lines: [
        line(),
        line({ key: "a", label: 'Has "quotes" and, a comma', note: "n, n" }),
        line({ key: "b", value: null, count: null, percentOfBook: undefined }),
      ],
    }))
    const columns = (row: string) => {
      // Count commas outside quoted fields.
      let inQuotes = false, cols = 1
      for (let i = 0; i < row.length; i++) {
        const c = row[i]
        if (c === '"') inQuotes = !inQuotes
        else if (c === "," && !inQuotes) cols++
      }
      return cols
    }
    const rows = csv.split("\n")
    const expected = columns(rows[0])
    expect(expected).toBe(6)
    for (const row of rows.slice(1, 4)) expect(columns(row)).toBe(expected)
  })
})

describe("ncrBasisLabel", () => {
  it("distinguishes filed from live position", () => {
    expect(ncrBasisLabel(line({ basis: "POSITION" }), true)).toBe("Position as filed")
    expect(ncrBasisLabel(line({ basis: "POSITION" }), false)).toBe("Position at export")
    expect(ncrBasisLabel(line({ basis: "PERIOD" }), true)).toBe("In-quarter")
  })
})
