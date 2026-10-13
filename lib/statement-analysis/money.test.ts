import { describe, expect, it } from "vitest"
import { parseRandToCents } from "./money"

describe("parseRandToCents", () => {
  it.each([
    ["1 234.56", 123456],
    ["-1 234.56", -123456],
    ["R1 234.56", 123456],
    ["-R99.99", -9999],
    ["R-99.99", -9999],
    ["12,345.67", 1234567],
    ["0.05", 5],
    ["1 000 000.00", 100000000],
  ])("reads %s as %i cents", (text, cents) => {
    expect(parseRandToCents(text)).toBe(cents)
  })

  it("reads an FNB Cr suffix as positive and Dr as negative", () => {
    expect(parseRandToCents("9,999.99 Cr")).toBe(999999)
    expect(parseRandToCents("9,999.99Dr")).toBe(-999999)
  })

  it("returns null for anything that is not an amount with cents", () => {
    expect(parseRandToCents("")).toBeNull()
    expect(parseRandToCents("1234")).toBeNull()
    expect(parseRandToCents("12.3")).toBeNull()
    expect(parseRandToCents("abc")).toBeNull()
    expect(parseRandToCents("1 23.45")).toBeNull()
  })
})
