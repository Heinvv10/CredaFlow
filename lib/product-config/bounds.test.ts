import { describe, expect, it } from "vitest"
import { loanProductBoundsIssues } from "./bounds"

// Raw request values: amounts in rand, terms in days.
const valid = { minAmount: 500, maxAmount: 10_000, minTermDays: 30, maxTermDays: 90 }
const INT4_MAX = 2_147_483_647

describe("loanProductBoundsIssues", () => {
  it("accepts a valid product", () => {
    expect(loanProductBoundsIssues(valid)).toEqual([])
  })

  it("accepts min equal to max (MICRO30 is 30/30)", () => {
    expect(loanProductBoundsIssues({ ...valid, maxAmount: 500, maxTermDays: 30 })).toEqual([])
  })

  it("accepts rand amounts with cents", () => {
    expect(loanProductBoundsIssues({ ...valid, minAmount: 0.5, maxAmount: 99.99 })).toEqual([])
  })

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["below one cent", 0.001],
    ["a string", "500"],
    ["a boolean", true],
    ["an array", [500]],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s minAmount", (_label, value) => {
    expect(loanProductBoundsIssues({ ...valid, minAmount: value })).toEqual(["minAmount"])
  })

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a string", "10000"],
    ["a boolean", true],
    ["an array", [10_000]],
  ])("rejects %s maxAmount", (_label, value) => {
    expect(loanProductBoundsIssues({ ...valid, maxAmount: value })).toEqual(["maxAmount"])
  })

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["non-integer", 30.5],
    ["a string", "30"],
    ["a hex string", "0x1e"],
    ["a boolean", true],
  ])("rejects %s minTermDays", (_label, value) => {
    expect(loanProductBoundsIssues({ ...valid, minTermDays: value })).toEqual(["minTermDays"])
  })

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["non-integer", 90.5],
    ["a string", "90"],
    ["a boolean", true],
    ["an array", [90]],
  ])("rejects %s maxTermDays", (_label, value) => {
    expect(loanProductBoundsIssues({ ...valid, maxTermDays: value })).toEqual(["maxTermDays"])
  })

  it("rejects a minimum amount above the maximum", () => {
    expect(loanProductBoundsIssues({ ...valid, minAmount: 20_000 })).toEqual(["maxAmount"])
  })

  it("rejects a minimum term above the maximum", () => {
    expect(loanProductBoundsIssues({ ...valid, minTermDays: 120 })).toEqual(["maxTermDays"])
  })

  it("compares amounts on rounded cents", () => {
    expect(loanProductBoundsIssues({ ...valid, minAmount: 10.004, maxAmount: 10 })).toEqual([])
    expect(loanProductBoundsIssues({ ...valid, minAmount: 10.01, maxAmount: 10 })).toEqual(["maxAmount"])
  })

  it("checks only the max's own validity when the min is invalid", () => {
    expect(loanProductBoundsIssues({ ...valid, minAmount: 0, maxAmount: 0.1 })).toEqual(["minAmount"])
    expect(loanProductBoundsIssues({ ...valid, minTermDays: NaN, maxTermDays: 1 })).toEqual(["minTermDays"])
  })

  it("reports every offending field in order", () => {
    expect(loanProductBoundsIssues({ minAmount: 0, maxAmount: -1, minTermDays: 0, maxTermDays: 0 }))
      .toEqual(["minAmount", "maxAmount", "minTermDays", "maxTermDays"])
  })

  it("accepts large values up to the int4 storage ceiling", () => {
    expect(loanProductBoundsIssues({
      minAmount: 0.01, maxAmount: INT4_MAX / 100, minTermDays: 1, maxTermDays: INT4_MAX,
    })).toEqual([])
  })

  it("rejects values past the int4 storage ceiling", () => {
    expect(loanProductBoundsIssues({
      minAmount: 0.01, maxAmount: (INT4_MAX + 1) / 100, minTermDays: 1, maxTermDays: INT4_MAX + 1,
    })).toEqual(["maxAmount", "maxTermDays"])
    expect(loanProductBoundsIssues({
      ...valid, minAmount: (INT4_MAX + 1) / 100, minTermDays: INT4_MAX + 1,
    })).toEqual(["minAmount", "minTermDays"])
  })
})
