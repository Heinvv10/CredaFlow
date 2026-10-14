import { describe, expect, it } from "vitest"
import { annualSeasonal, biannual, monthly, skipN, stepUp } from "./structure-presets"

describe("structure presets", () => {
  it("monthly", () => {
    expect(monthly(3)).toEqual([1, 1, 1])
  })

  it("annualSeasonal follows the calendar month of each due date", () => {
    // First due in November: Nov Dec Jan Feb Mar Apr May Jun ...
    expect(annualSeasonal(8, 11, [3, 4, 5], 3, 0.5)).toEqual([0.5, 0.5, 0.5, 0.5, 3, 3, 3, 0.5])
  })

  it("biannual pays weight 1 in the two months only", () => {
    expect(biannual(13, [3, 9], 1)).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0])
  })

  it("skipN", () => {
    expect(skipN(5, 2)).toEqual([0, 0, 1, 1, 1])
  })

  it("stepUp holds weight 1 until the first step, then each step's weight", () => {
    expect(stepUp(6, [{ fromPeriod: 2, weight: 1.5 }, { fromPeriod: 4, weight: 2 }])).toEqual([1, 1, 1.5, 1.5, 2, 2])
    expect(stepUp(3, [{ fromPeriod: 0, weight: 0.5 }])).toEqual([0.5, 0.5, 0.5])
  })

  it.each([
    ["monthly(0)", () => monthly(0)],
    ["monthly(1.5)", () => monthly(1.5)],
    ["annualSeasonal month 13", () => annualSeasonal(12, 13, [3], 3, 0.5)],
    ["annualSeasonal season month 0", () => annualSeasonal(12, 1, [0], 3, 0.5)],
    ["annualSeasonal negative weight", () => annualSeasonal(12, 1, [3], -1, 0.5)],
    ["biannual same month twice", () => biannual(12, [3, 3], 1)],
    ["biannual bad start month", () => biannual(12, [3, 9], 0)],
    ["skipN skipping every period", () => skipN(3, 3)],
    ["skipN negative", () => skipN(3, -1)],
    ["stepUp unsorted", () => stepUp(6, [{ fromPeriod: 4, weight: 2 }, { fromPeriod: 2, weight: 1.5 }])],
    ["stepUp out of range", () => stepUp(6, [{ fromPeriod: 6, weight: 2 }])],
    ["stepUp negative weight", () => stepUp(6, [{ fromPeriod: 1, weight: -2 }])],
  ])("refuses %s", (_name, make) => {
    expect(make).toThrow(RangeError)
  })
})
