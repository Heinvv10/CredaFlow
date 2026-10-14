import { describe, expect, it } from "vitest"
import { parseReferenceRateInput } from "./reference-rate-input"

describe("parseReferenceRateInput", () => {
  it("accepts a reference basis, a calendar date and a decimal rate of up to 6 places", () => {
    expect(parseReferenceRateInput({ basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.12" }))
      .toEqual({ basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.12" })
    expect(parseReferenceRateInput({ basis: "REPO", effectiveDate: "2027-01-15", rate: 0.0825 }))
      .toEqual({ basis: "REPO", effectiveDate: "2027-01-15", rate: "0.0825" })
    expect(parseReferenceRateInput({ basis: "JIBAR", effectiveDate: "2027-01-15", rate: "0.499999" }))
      .toEqual({ basis: "JIBAR", effectiveDate: "2027-01-15", rate: "0.499999" })
  })

  it.each([
    ["FIXED is a contract basis, not a reference", { basis: "FIXED", effectiveDate: "2027-01-15", rate: "0.12" }, ["basis"]],
    ["a percentage instead of a decimal", { basis: "PRIME", effectiveDate: "2027-01-15", rate: "12" }, ["rate"]],
    ["more than 6 places", { basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.1234567" }, ["rate"]],
    ["a negative rate", { basis: "PRIME", effectiveDate: "2027-01-15", rate: "-0.01" }, ["rate"]],
    ["a zero rate (below the sanity band)", { basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.000000" }, ["rate"]],
    ["50% (above the sanity band)", { basis: "PRIME", effectiveDate: "2027-01-15", rate: "0.5" }, ["rate"]],
    ["exponent notation", { basis: "PRIME", effectiveDate: "2027-01-15", rate: 1e-7 }, ["rate"]],
    ["a date that does not exist", { basis: "PRIME", effectiveDate: "2027-02-30", rate: "0.12" }, ["effectiveDate"]],
    ["no body", null, ["basis", "effectiveDate", "rate"]],
  ])("refuses %s", (_label, body, fields) => {
    const result = parseReferenceRateInput(body)
    expect("errors" in result && Object.keys(result.errors).sort()).toEqual(fields)
  })
})
