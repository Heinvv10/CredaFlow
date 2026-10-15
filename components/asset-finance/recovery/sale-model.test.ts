import { describe, expect, it } from "vitest"
import { emptySaleForm, priceBelowValuation, saleActions, saleBody, screeningSummary, type SaleLike } from "./sale-model"

const filled = { ...emptySaleForm("val-1"), buyerName: "TEST Buyer", buyerIdentifier: "REG-123", buyerAddress: "1 Test Street", price: "640 000" }

describe("saleBody", () => {
  it("sends the price in cents and omits what is blank", () => {
    expect(saleBody(filled, false)).toEqual({ body: {
      channel: "AUCTION", buyerType: "PERSON", buyerName: "TEST Buyer", buyerIdentifier: "REG-123", buyerAddress: "1 Test Street", priceInclVatCents: 64_000_000, valuationId: "val-1",
    } })
  })
  it("needs the reason, and sends it, only for a price under the valuation", () => {
    expect(saleBody(filled, true)).toMatchObject({ error: expect.stringMatching(/reason/) })
    expect(saleBody({ ...filled, belowValuationReason: "Auction reserve not met" }, true)).toMatchObject({ body: { belowValuationReason: "Auction reserve not met" } })
    expect(saleBody({ ...filled, belowValuationReason: "ignored when at or above" }, false)).not.toHaveProperty("body.belowValuationReason")
  })
  it("asks for the buyer, the valuation and a price", () => {
    expect(saleBody({ ...filled, price: "" }, false)).toMatchObject({ error: expect.stringMatching(/price/) })
    expect(saleBody({ ...filled, valuationId: "" }, false)).toMatchObject({ error: expect.stringMatching(/valuation/) })
    expect(saleBody({ ...filled, buyerIdentifier: "x" }, false)).toMatchObject({ error: expect.stringMatching(/ID or registration/) })
  })
})

describe("priceBelowValuation", () => {
  it("compares the price with the highest valuation offered", () => {
    expect(priceBelowValuation(filled, [60_000_000, 70_000_000])).toBe(true)
    expect(priceBelowValuation(filled, [60_000_000, 64_000_000])).toBe(false)
    expect(priceBelowValuation({ ...filled, price: "" }, [70_000_000])).toBe(false)
  })
})

describe("screeningSummary", () => {
  it("names the kinds that matched and never anything else", () => {
    expect(screeningSummary({ match: false, matches: [] })).toMatch(/^No match/)
    expect(screeningSummary({ match: true, matches: [{ kind: "STAFF", on: "NAME" }, { kind: "BORROWER", on: "IDENTIFIER" }] })).toBe("Matched a staff member (name), the borrower (ID)")
    expect(screeningSummary(null)).toMatch(/^No match/)
  })
})

describe("saleActions", () => {
  const sale = (over: Partial<SaleLike> = {}): SaleLike => ({ status: "PENDING_APPROVAL", belowValuation: false, relatedPartyMatch: false, createdById: "u-1", approvedById: null, ...over })
  const officer = { canManage: true, canDecide: false }
  const admin = { canManage: true, canDecide: true }

  it("completes a sale that needs no approval, and offers no approval", () => {
    expect(saleActions(sale(), "u-1", officer)).toEqual({ approve: false, complete: true, cancel: true, waitingOn: null })
  })
  it("holds a flagged sale for a second approver and never lets its proposer approve", () => {
    const flagged = sale({ relatedPartyMatch: true })
    expect(saleActions(flagged, "u-1", officer)).toMatchObject({ approve: false, complete: false, waitingOn: "approver" })
    expect(saleActions(flagged, "u-1", admin)).toMatchObject({ approve: false, complete: false, waitingOn: "different-approver" })
    expect(saleActions(flagged, "u-2", admin)).toMatchObject({ approve: true, complete: false })
  })
  it("completes once approved, and offers nothing on a sale that is no longer pending", () => {
    expect(saleActions(sale({ belowValuation: true, approvedById: "u-2" }), "u-1", officer)).toMatchObject({ approve: false, complete: true, waitingOn: null })
    expect(saleActions(sale({ status: "COMPLETED" }), "u-1", admin)).toEqual({ approve: false, complete: false, cancel: false, waitingOn: null })
  })
})
