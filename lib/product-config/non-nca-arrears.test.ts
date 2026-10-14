import { describe, expect, it } from "vitest"
import { nonNcaArrearsAudit, parseNonNcaArrearsTerms } from "./non-nca-arrears"

describe("parseNonNcaArrearsTerms", () => {
  it("leaves absent terms out (unchanged on update)", () => {
    expect(parseNonNcaArrearsTerms({ code: "X" })).toEqual({ data: {} })
  })

  it("accepts a decimal margin below 1 and whole-cent fees, and null to clear", () => {
    expect(parseNonNcaArrearsTerms({ nonNcaDefaultInterestMargin: "0.02", nonNcaCollectionFeeCents: 25_000 }))
      .toEqual({ data: { nonNcaDefaultInterestMargin: "0.02", nonNcaCollectionFeeCents: 25_000 } })
    expect(parseNonNcaArrearsTerms({ nonNcaDefaultInterestMargin: 0, nonNcaCollectionFeeCents: 0 }))
      .toEqual({ data: { nonNcaDefaultInterestMargin: "0", nonNcaCollectionFeeCents: 0 } })
    expect(parseNonNcaArrearsTerms({ nonNcaDefaultInterestMargin: null, nonNcaCollectionFeeCents: null }))
      .toEqual({ data: { nonNcaDefaultInterestMargin: null, nonNcaCollectionFeeCents: null } })
  })

  it.each([
    [{ nonNcaDefaultInterestMargin: "2" }, "nonNcaDefaultInterestMargin"], // a percentage where the decimal belongs
    [{ nonNcaDefaultInterestMargin: "-0.01" }, "nonNcaDefaultInterestMargin"],
    [{ nonNcaDefaultInterestMargin: "0.0000001" }, "nonNcaDefaultInterestMargin"],
    [{ nonNcaDefaultInterestMargin: "abc" }, "nonNcaDefaultInterestMargin"],
    [{ nonNcaCollectionFeeCents: -1 }, "nonNcaCollectionFeeCents"],
    [{ nonNcaCollectionFeeCents: 10.5 }, "nonNcaCollectionFeeCents"],
    [{ nonNcaCollectionFeeCents: "250" }, "nonNcaCollectionFeeCents"],
    [{ nonNcaCollectionFeeCents: 2_147_483_648 }, "nonNcaCollectionFeeCents"],
  ])("refuses %j", (body, field) => {
    expect(parseNonNcaArrearsTerms(body)).toEqual({ issues: [field] })
  })

  it("audits the margin as its decimal string", () => {
    expect(nonNcaArrearsAudit({ nonNcaDefaultInterestMargin: { toString: () => "0.02" }, nonNcaCollectionFeeCents: 25_000 }))
      .toEqual({ nonNcaDefaultInterestMargin: "0.02", nonNcaCollectionFeeCents: 25_000 })
    expect(nonNcaArrearsAudit({ nonNcaDefaultInterestMargin: null, nonNcaCollectionFeeCents: null }))
      .toEqual({ nonNcaDefaultInterestMargin: null, nonNcaCollectionFeeCents: null })
  })
})
