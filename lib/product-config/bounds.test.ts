import { describe, expect, it } from "vitest"
import { loanProductBoundsIssues } from "./bounds"

const valid = { minAmount: 50_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90 }

describe("loanProductBoundsIssues", () => {
  it("accepts a valid product", () => {
    expect(loanProductBoundsIssues(valid)).toEqual([])
  })

  it("accepts min equal to max (MICRO30 is 30/30)", () => {
    expect(loanProductBoundsIssues({ ...valid, maxAmount: 50_000, maxTermDays: 30 })).toEqual([])
  })

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["fractional cents", 100.5],
    ["a string", "500"],
    ["undefined", undefined],
  ])("rejects %s minAmount", (_label, value) => {
    expect(loanProductBoundsIssues({ ...valid, minAmount: value })).toEqual(["minAmount"])
  })

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["fractional cents", 100.5],
  ])("rejects %s maxAmount", (_label, value) => {
    expect(loanProductBoundsIssues({ ...valid, maxAmount: value })).toEqual(["maxAmount"])
  })

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["non-integer", 30.5],
  ])("rejects %s minTermDays", (_label, value) => {
    expect(loanProductBoundsIssues({ ...valid, minTermDays: value })).toEqual(["minTermDays"])
  })

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["non-integer", 90.5],
  ])("rejects %s maxTermDays", (_label, value) => {
    expect(loanProductBoundsIssues({ ...valid, maxTermDays: value })).toEqual(["maxTermDays"])
  })

  it("rejects a minimum amount above the maximum", () => {
    expect(loanProductBoundsIssues({ ...valid, minAmount: 2_000_000 })).toEqual(["maxAmount"])
  })

  it("rejects a minimum term above the maximum", () => {
    expect(loanProductBoundsIssues({ ...valid, minTermDays: 120 })).toEqual(["maxTermDays"])
  })

  it("checks only the max's own validity when the min is invalid", () => {
    expect(loanProductBoundsIssues({ ...valid, minAmount: 0, maxAmount: 10 })).toEqual(["minAmount"])
    expect(loanProductBoundsIssues({ ...valid, minTermDays: NaN, maxTermDays: 1 })).toEqual(["minTermDays"])
  })

  it("reports every offending field in order", () => {
    expect(loanProductBoundsIssues({ minAmount: 0, maxAmount: -1, minTermDays: 0, maxTermDays: 0 }))
      .toEqual(["minAmount", "maxAmount", "minTermDays", "maxTermDays"])
  })

  it("imposes no upper cap", () => {
    expect(loanProductBoundsIssues({
      minAmount: 1, maxAmount: Number.MAX_SAFE_INTEGER, minTermDays: 1, maxTermDays: 100_000,
    })).toEqual([])
  })
})
