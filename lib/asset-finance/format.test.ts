import { describe, expect, it } from "vitest"
import { formatIsoDate, formatMoney, formatMoneyInput } from "./format"

const NBSP = " "

describe("formatMoney", () => {
  it("puts the sign before the currency", () => {
    expect(formatMoney(-128_773)).toBe(`-R${NBSP}1,287.73`)
    expect(formatMoney(128_773)).toBe(`R${NBSP}1,287.73`)
    expect(formatMoney(0)).toBe(`R${NBSP}0.00`)
    expect(formatMoney(-5)).toBe(`-R${NBSP}0.05`)
  })

  it("never breaks between R and the digits", () => {
    expect(formatMoney(9_999_999_999)).toBe(`R${NBSP}99,999,999.99`)
    expect(formatMoney(9_999_999_999)).not.toMatch(/R /)
  })
})

describe("formatIsoDate", () => {
  it("prints a calendar date the way the app prints dates", () => {
    expect(formatIsoDate("2026-06-08")).toBe("08 Jun 2026")
    expect(formatIsoDate("2026-12-31")).toBe("31 Dec 2026")
    expect(formatIsoDate("2027-01-01")).toBe("01 Jan 2027")
  })

  it("returns anything that is not an ISO date unchanged", () => {
    expect(formatIsoDate("soon")).toBe("soon")
  })
})

describe("formatMoneyInput", () => {
  it("formats a typed amount for display", () => {
    expect(formatMoneyInput("25000000")).toBe(`R${NBSP}25,000,000.00`)
    expect(formatMoneyInput("1 250 000.5")).toBe(`R${NBSP}1,250,000.50`)
    expect(formatMoneyInput("")).toBe("")
  })

  it("keeps a negative only where one is allowed", () => {
    expect(formatMoneyInput("-150000", true)).toBe(`-R${NBSP}150,000.00`)
    expect(formatMoneyInput("-150000")).toBe("-150000")
  })

  it("shows text that is not an amount as typed", () => {
    expect(formatMoneyInput("12abc")).toBe("12abc")
  })
})
