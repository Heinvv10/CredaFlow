import { describe, expect, it } from "vitest"
import { nonNcaArrearsBody, nonNcaArrearsValues } from "./non-nca-arrears-form"
import { parseNonNcaArrearsTerms } from "./non-nca-arrears"

describe("loan-product form NON_NCA arrears terms", () => {
  it("shows stored terms as % a year and rand", () => {
    expect(nonNcaArrearsValues("0.02", 25_000)).toEqual({ marginPercent: "2", feeRand: "250.00" })
    expect(nonNcaArrearsValues("0.025", 0)).toEqual({ marginPercent: "2.5", feeRand: "0.00" })
    expect(nonNcaArrearsValues(null, null)).toEqual({ marginPercent: "", feeRand: "" })
  })

  it("sends what the API accepts, and empty fields as null", () => {
    const sent = nonNcaArrearsBody({ marginPercent: "2.5", feeRand: "R250" })
    expect(sent).toEqual({ body: { nonNcaDefaultInterestMargin: "0.025", nonNcaCollectionFeeCents: 25_000 } })
    if (!("body" in sent)) throw new Error("expected a body")
    expect(parseNonNcaArrearsTerms(sent.body)).toEqual({ data: sent.body })
    expect(nonNcaArrearsBody({ marginPercent: " ", feeRand: "" })).toEqual({ body: { nonNcaDefaultInterestMargin: null, nonNcaCollectionFeeCents: null } })
  })

  it("round-trips a stored value through the form unchanged", () => {
    expect(nonNcaArrearsBody(nonNcaArrearsValues("0.0175", 12_345))).toEqual({
      body: { nonNcaDefaultInterestMargin: "0.0175", nonNcaCollectionFeeCents: 12_345 },
    })
  })

  it("refuses malformed input with a message naming the field", () => {
    expect(nonNcaArrearsBody({ marginPercent: "two", feeRand: "" })).toEqual({ error: expect.stringMatching(/margin/) })
    expect(nonNcaArrearsBody({ marginPercent: "", feeRand: "12.345" })).toEqual({ error: expect.stringMatching(/fee/) })
  })
})
