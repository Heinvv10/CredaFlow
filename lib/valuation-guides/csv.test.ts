import { describe, expect, it } from "vitest"
import { GUIDE_CSV_HEADER, MAX_GUIDE_ROWS, MAX_SHOWN_PROBLEMS, parseGuideCsv } from "./csv"

const HEADER = "make,model,year,variant,trade_cents,retail_cents"
const file = (...lines: string[]) => new TextEncoder().encode(lines.join("\n"))
const problems = (...lines: string[]) => {
  const result = parseGuideCsv(file(...lines))
  if (result.ok) throw new Error("expected the file to be refused")
  return result
}

describe("parseGuideCsv", () => {
  it("reads a clean file: trimmed text, cents as integers, line numbers from the header's 1", () => {
    const result = parseGuideCsv(new TextEncoder().encode(`﻿${HEADER}\r\nToyota , Hilux 2.8 GD-6,2024,"Raider, double cab",45000000,52000000\r\nCAT,320,2022,,180000000,210000000\r\n`))
    expect(result).toEqual({
      ok: true,
      rows: [
        { lineNumber: 2, make: "Toyota", model: "Hilux 2.8 GD-6", year: 2024, variant: "Raider, double cab", tradeCents: 45_000_000, retailCents: 52_000_000 },
        { lineNumber: 3, make: "CAT", model: "320", year: 2022, variant: "", tradeCents: 180_000_000, retailCents: 210_000_000 },
      ],
    })
    expect(GUIDE_CSV_HEADER).toBe(HEADER)
  })

  it("reads a doubled quote inside a quoted field as one quote", () => {
    const result = parseGuideCsv(file(HEADER, `TEST,"EX ""Pro""",2025,,1,1`))
    expect(result.ok && result.rows[0].model).toBe(`EX "Pro"`)
  })

  it("refuses an empty file, a wrong header and a header with no rows", () => {
    expect(problems("").problems).toEqual([{ line: 1, reason: "The file is empty: it needs the header line and at least one row" }])
    expect(problems("Make,Model,Year,Variant,Trade,Retail", "TEST,EX,2025,,1,1").problems[0])
      .toEqual({ line: 1, reason: `The first line must be exactly: ${HEADER}` })
    expect(problems(HEADER, "").problems).toEqual([{ line: 1, reason: "The file has a header but no rows" }])
  })

  it("refuses text that is not UTF-8", () => {
    const result = parseGuideCsv(new Uint8Array([...new TextEncoder().encode(`${HEADER}\nTEST,EX`), 0xff, 0xfe, ...new TextEncoder().encode(",2025,,1,1")]))
    expect(result).toEqual({ ok: false, total: 1, problems: [{ line: 1, reason: "The file is not UTF-8 text" }] })
  })

  it("refuses a short or long row, a stray quote, an unclosed quote and an empty line between rows", () => {
    const result = problems(HEADER, "TEST,EX,2025,,1", "TEST,EX,2025,,1,1,9", `TE"ST,EX,2025,,1,1`, `"TEST,EX,2025,,1,1`, "", "TEST,EX-9,2025,,1,1")
    expect(result.problems).toEqual([
      { line: 2, reason: "Expected 6 columns, found 5" },
      { line: 3, reason: "Expected 6 columns, found 7" },
      { line: 4, reason: "A quote may only open and close a whole field" },
      { line: 5, reason: "A quoted field is not closed on its line" },
      { line: 6, reason: "An empty line between rows" },
    ])
  })

  it("refuses money that is not a whole positive number of cents within range", () => {
    const reasons = (trade: string) => problems(HEADER, `TEST,EX,2025,,${trade},2147483647`).problems[0].reason
    const notCents = "trade_cents must be a whole number of cents (digits only, no separators or decimals)"
    expect(reasons("1000.00")).toBe(notCents)
    expect(reasons("1 000")).toBe(notCents)
    expect(reasons("R1000")).toBe(notCents)
    expect(reasons("")).toBe(notCents)
    expect(reasons("0")).toBe("trade_cents must be more than 0")
    expect(problems(HEADER, "TEST,EX,2025,,1,2147483648").problems[0].reason).toBe("retail_cents must be at most 2147483647")
  })

  it("refuses a year out of range, a missing make or model, over-long text and a trade value above retail, all reasons on one line", () => {
    expect(problems(HEADER, "TEST,EX,1949,,1,1").problems[0].reason).toBe("year must be a whole year from 1950 to 2100")
    expect(problems(HEADER, "TEST,EX,20x5,,1,1").problems[0].reason).toBe("year must be a whole year from 1950 to 2100")
    expect(problems(HEADER, ` ,,2025,${"v".repeat(101)},5,4`).problems[0].reason)
      .toBe("make is required; model is required; variant is longer than 100 characters; the trade value is above the retail value")
  })

  it("refuses a cell a spreadsheet would run as a formula, and control characters", () => {
    expect(problems(HEADER, "=HYPERLINK(1),EX,2025,,1,1").problems[0].reason).toBe("make starts with =, +, - or @ (a spreadsheet formula is refused)")
    expect(problems(HEADER, "TEST,EX,2025,@v,1,1").problems[0].reason).toBe("variant starts with =, +, - or @ (a spreadsheet formula is refused)")
    expect(problems(HEADER, "TEST,E\tX,2025,,1,1").problems[0].reason).toBe("model contains a control character")
  })

  it("refuses a duplicate key, case and outer spaces ignored, naming the first line", () => {
    expect(problems(HEADER, "TEST,EX,2025,Long,1,1", "TEST,EX,2025,,1,1", "test , ex,2025, LONG ,2,2").problems)
      .toEqual([{ line: 4, reason: "duplicates line 2 (same make, model, year and variant)" }])
  })

  it("reports every problem but shows at most the first 200, and refuses more rows than the limit", () => {
    const bad = Array.from({ length: 250 }, () => "TEST,EX,2025,,x,1")
    const result = problems(HEADER, ...bad)
    expect(result.total).toBe(250)
    expect(result.problems).toHaveLength(MAX_SHOWN_PROBLEMS)
    const many = Array.from({ length: MAX_GUIDE_ROWS + 1 }, (_, i) => `TEST,EX-${i},2025,,1,1`)
    expect(problems(HEADER, ...many).problems).toEqual([{ line: 1, reason: `The file has more than ${MAX_GUIDE_ROWS} rows` }])
  })
})
