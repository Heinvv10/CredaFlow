import { describe, expect, it } from "vitest"
import { parseSaleInput } from "./recovery-sale-input"

const valid = {
  channel: "AUCTION", buyerType: "PERSON", buyerName: "  TEST Buyer  ", buyerIdentifier: "7001015800084",
  buyerAddress: "2 Buyer Street", priceInclVatCents: 120_000_000, valuationId: "val_1",
}

describe("parseSaleInput", () => {
  it("trims the text and defaults the optional fields to null", () => {
    const parsed = parseSaleInput(valid)
    expect(parsed).toEqual({ ok: true, value: { ...valid, buyerName: "TEST Buyer", buyerVatNumber: null, belowValuationReason: null } })
  })

  it("keeps a VAT number and a below-valuation reason", () => {
    const parsed = parseSaleInput({ ...valid, buyerVatNumber: "4000000099", belowValuationReason: "Damaged chassis found on inspection" })
    expect(parsed).toMatchObject({ ok: true, value: { buyerVatNumber: "4000000099", belowValuationReason: "Damaged chassis found on inspection" } })
  })

  it.each([
    ["an unknown channel", { channel: "FLEA_MARKET" }, /channel/],
    ["an unknown buyer type", { buyerType: "ROBOT" }, /buyerType/],
    ["a zero price", { priceInclVatCents: 0 }, /priceInclVatCents/],
    ["a fractional price", { priceInclVatCents: 100.5 }, /priceInclVatCents/],
    ["a price sent as text", { priceInclVatCents: "100" }, /priceInclVatCents/],
    ["a blank buyer name", { buyerName: "   " }, /buyerName/],
    ["a missing identifier", { buyerIdentifier: undefined }, /buyerIdentifier/],
    ["a missing valuation", { valuationId: "" }, /valuationId/],
    ["an over-long reason", { belowValuationReason: "x".repeat(1_001) }, /belowValuationReason/],
  ])("refuses %s", (_label, over, message) => {
    const parsed = parseSaleInput({ ...valid, ...over })
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.error).toMatch(message)
  })

  it("refuses a body that is not an object", () => {
    expect(parseSaleInput(null).ok).toBe(false)
    expect(parseSaleInput("x").ok).toBe(false)
  })
})
