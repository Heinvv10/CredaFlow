import { describe, expect, it } from "vitest"
import { formatReport, scoreCase, type AccuracyCase } from "./run"

const CASE: AccuracyCase = {
  file: "acme-2026-07.pdf",
  docType: "PAYSLIP",
  expect: { grossIncome: 2100000, netIncome: 1770128, employerName: "Acme Widgets (Pty) Ltd" },
  traps: { grossIncome: 10320000 },
}

const field = (v: unknown) => ({ value: v })

describe("accuracy scorer", () => {
  it("counts a correct read", () => {
    const out = scoreCase(CASE, {
      grossIncome: field(2100000),
      netIncome: field(1770128),
      employerName: field("Acme Widgets (Pty) Ltd"),
    })

    expect(out.fields.every((f) => f.status === "correct")).toBe(true)
  })

  // A year-to-date read is a DIFFERENT bug from a misread digit: one is fixed in
  // the prompt or the column logic, the other by feeding the model better input.
  // Collapsing them into "wrong" would hide which one is actually happening.
  it("distinguishes a wrong-column read from an ordinary wrong value", () => {
    const out = scoreCase(CASE, {
      grossIncome: field(10320000),
      netIncome: field(999),
      employerName: field("Acme Widgets (Pty) Ltd"),
    })

    expect(out.fields.find((f) => f.field === "grossIncome")!.status).toBe("trap")
    expect(out.fields.find((f) => f.field === "netIncome")!.status).toBe("wrong")
  })

  it("reports an absent field as missing, not as wrong", () => {
    const out = scoreCase(CASE, { netIncome: field(1770128), employerName: field("Acme Widgets (Pty) Ltd") })

    expect(out.fields.find((f) => f.field === "grossIncome")!.status).toBe("missing")
  })

  it.each([
    ["an empty string", ""],
    ["null", null],
  ])("treats %s as missing rather than a value", (_label, empty) => {
    const out = scoreCase(CASE, { grossIncome: field(empty) })

    expect(out.fields.find((f) => f.field === "grossIncome")!.status).toBe("missing")
  })

  it("accepts a numeric string for a numeric field", () => {
    const out = scoreCase(CASE, { grossIncome: field("2100000") })

    expect(out.fields.find((f) => f.field === "grossIncome")!.status).toBe("correct")
  })

  // Whitespace and casing differences in an employer name are not extraction
  // defects, and counting them as such would bury the failures that matter.
  it("ignores case and surrounding whitespace on text fields", () => {
    const out = scoreCase(CASE, { employerName: field("  acme widgets (pty) ltd ") })

    expect(out.fields.find((f) => f.field === "employerName")!.status).toBe("correct")
  })

  it("records a failed extraction instead of scoring it as zero fields", () => {
    const out = scoreCase(CASE, null, "VLM request timed out")

    expect(out.error).toBe("VLM request timed out")
    expect(out.fields).toEqual([])
  })

  it("reports the tally and names the wrong-column hits", () => {
    const report = formatReport([
      scoreCase(CASE, {
        grossIncome: field(10320000),
        netIncome: field(1770128),
        employerName: field("Acme Widgets (Pty) Ltd"),
      }),
    ])

    expect(report).toContain("2/3 fields correct (67%)")
    expect(report).toContain("1 read from the WRONG COLUMN")
    expect(report).toMatch(/year-to-date figure was taken for this month/)
  })

  it("does not divide by zero on an empty run", () => {
    expect(formatReport([])).toContain("0/0 fields correct (0%)")
  })
})
