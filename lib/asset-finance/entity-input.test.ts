import { describe, expect, it } from "vitest"
import { financialsChanged, parseBusinessEntityInput } from "./entity-input"

const TODAY = new Date("2026-10-13T10:00:00Z")
const company = (over: Record<string, unknown> = {}) => ({
  type: "COMPANY",
  legalName: "TEST Synthetic Plant Hire (Pty) Ltd",
  registrationNumber: "2015/123456/07",
  ...over,
})
const errorsOf = (body: unknown) => {
  const result = parseBusinessEntityInput(body, TODAY)
  return "errors" in result ? result.errors : {}
}

describe("parseBusinessEntityInput", () => {
  it("accepts a minimal company and normalises empty optionals to null", () => {
    const result = parseBusinessEntityInput(company({ tradingName: "  ", vatNumber: "" }), TODAY)
    expect(result).toEqual({
      data: expect.objectContaining({
        type: "COMPANY",
        registrationNumber: "2015/123456/07",
        tradingName: null,
        vatNumber: null,
        mastersReference: null,
        annualTurnover: null,
        financialYearEnd: null,
      }),
    })
  })

  it.each([
    ["COMPANY", "2015/123456"],
    ["COMPANY", "15/123456/07"],
    ["CC", "IT1234/2015"],
    ["TRUST", "2015/123456/07"],
    ["TRUST", "1234/2015"],
    ["PARTNERSHIP", "x"],
  ])("refuses a %s registration number %j", (type, registrationNumber) => {
    expect(errorsOf(company({ type, registrationNumber }))).toHaveProperty("registrationNumber")
  })

  it.each([
    ["COMPANY", "2015/123456/07"],
    ["CC", "1998/012345/23"],
    ["TRUST", "IT1234/2015"],
    ["TRUST", "it 987/15 (T)"],
    ["PARTNERSHIP", "P-TEST-0001"],
  ])("accepts a %s registration number %j", (type, registrationNumber) => {
    expect(errorsOf(company({ type, registrationNumber }))).toEqual({})
  })

  it("fills a trust's Master's reference from its IT number", () => {
    const result = parseBusinessEntityInput(company({ type: "TRUST", registrationNumber: "it1234/2015" }), TODAY)
    expect(result).toMatchObject({ data: { registrationNumber: "IT1234/2015", mastersReference: "IT1234/2015" } })
  })

  it("refuses a Master's reference on anything but a trust", () => {
    expect(errorsOf(company({ mastersReference: "IT1/2015" }))).toHaveProperty("mastersReference")
  })

  it("requires the financial year with a turnover or asset value, and refuses one in the future", () => {
    expect(errorsOf(company({ annualTurnover: 150_000_000 }))).toHaveProperty("financialYearEnd")
    expect(errorsOf(company({ totalAssetValue: 1, financialYearEnd: "2026-10-14" }))).toHaveProperty("financialYearEnd")
    expect(errorsOf(company({ financialYearEnd: "2026-02-28" }))).toHaveProperty("financialYearEnd")
    expect(errorsOf(company({ annualTurnover: 150_000_000, financialYearEnd: "2026-02-28" }))).toEqual({})
  })

  it.each([[-1], [1.5], ["100"], [2_147_483_648]])("refuses turnover %j (cents, INT4)", (annualTurnover) => {
    expect(errorsOf(company({ annualTurnover, financialYearEnd: "2026-02-28" }))).toHaveProperty("annualTurnover")
  })

  it("refuses a malformed VAT number, postal code, type and missing name", () => {
    const errors = errorsOf({ type: "LLC", vatNumber: "123", postalCode: "12", registrationNumber: "2015/123456/07" })
    expect(Object.keys(errors).sort()).toEqual(["legalName", "postalCode", "type", "vatNumber"])
  })

  it("refuses a non-object body", () => {
    expect(errorsOf([])).toHaveProperty("body")
  })
})

describe("financialsChanged", () => {
  const base = { annualTurnover: 1, totalAssetValue: null, financialYearEnd: new Date("2026-02-28") }
  it("is false for identical figures and true when any figure or the year moves", () => {
    expect(financialsChanged(base, { ...base, financialYearEnd: new Date("2026-02-28") })).toBe(false)
    expect(financialsChanged(base, { ...base, annualTurnover: 2 })).toBe(true)
    expect(financialsChanged(base, { ...base, totalAssetValue: 0 })).toBe(true)
    expect(financialsChanged(base, { ...base, financialYearEnd: new Date("2025-02-28") })).toBe(true)
  })
})
