import { describe, expect, it } from "vitest"
import { percentToDecimal, ratePercent } from "./deal-labels"

describe("percentToDecimal", () => {
  it.each([
    ["11.75", false, "0.1175"],
    ["5", false, "0.05"],
    ["0", false, "0"],
    ["13.4999", false, "0.134999"],
    ["-0.5", true, "-0.005"],
    ["1.5", true, "0.015"],
  ])("%s → %s", (input, negative, expected) => {
    expect(percentToDecimal(input, negative)).toBe(expected)
  })

  it.each([["-1", false], ["100", false], ["1.23456", false], ["abc", true], ["", false]])("refuses %j", (input, negative) => {
    expect(percentToDecimal(input, negative)).toBeNull()
  })

  it("round-trips with ratePercent", () => {
    expect(ratePercent("0.1175")).toBe("11.75%")
  })
})
