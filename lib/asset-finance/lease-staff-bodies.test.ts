import { describe, expect, it } from "vitest"
import { claimBody, electionBody, inspectionBody, readingBody } from "./lease-staff-bodies"

describe("readingBody", () => {
  it("sends the date and a whole-number value", () => {
    expect(readingBody({ readingDate: "2030-06-15", value: " 1250 " })).toEqual({ body: { readingDate: "2030-06-15", value: 1250 } })
  })
  it("refuses a fractional value or a missing date", () => {
    expect(readingBody({ readingDate: "2030-06-15", value: "12.5" })).toHaveProperty("error")
    expect(readingBody({ readingDate: "", value: "12" })).toHaveProperty("error")
  })
})

describe("claimBody", () => {
  const ok = { supplierId: "s-1", documentId: "d-1", amountRands: "4500.50", description: " New hydraulic hose ", meterReadingId: "" }
  it("converts the amount to cents and omits an empty meter reading", () => {
    expect(claimBody(ok)).toEqual({ body: { supplierId: "s-1", providerInvoiceDocumentId: "d-1", amountExclVatCents: 450_050, description: "New hydraulic hose" } })
    expect(claimBody({ ...ok, meterReadingId: "m-1" })).toMatchObject({ body: { meterReadingId: "m-1" } })
  })
  it("refuses a missing provider, invoice, amount or description", () => {
    for (const bad of [{ supplierId: "" }, { documentId: "" }, { amountRands: "0" }, { amountRands: "12.345" }, { description: "ab" }]) {
      expect(claimBody({ ...ok, ...bad })).toHaveProperty("error")
    }
  })
})

describe("electionBody", () => {
  it("sends a return or an extension with the outcome alone", () => {
    expect(electionBody({ outcome: "EXTEND", valuationId: "v-1", priceRands: "1" })).toEqual({ body: { outcome: "EXTEND" } })
  })
  it("sends a purchase with its price in cents and its valuation", () => {
    expect(electionBody({ outcome: "PURCHASE", valuationId: "v-1", priceRands: "250 000.00" })).toEqual({
      body: { outcome: "PURCHASE", purchasePriceExclVatCents: 25_000_000, valuationId: "v-1" },
    })
    expect(electionBody({ outcome: "PURCHASE", valuationId: "", priceRands: "1000" })).toHaveProperty("error")
    expect(electionBody({ outcome: "PURCHASE", valuationId: "v-1", priceRands: "" })).toHaveProperty("error")
  })
})

describe("inspectionBody", () => {
  const ok = { inspectedOn: "2030-06-15", condition: "Good, minor scuffs", finalReading: "", usageContracted: false, damage: [] }
  it("sends the condition and damage items in cents, dropping blank lines", () => {
    const built = inspectionBody({ ...ok, damage: [{ description: "Cracked mirror", amountRands: "1200.00" }, { description: "", amountRands: "" }] })
    expect(built).toEqual({ body: { inspectedOn: "2030-06-15", condition: "Good, minor scuffs", damage: [{ description: "Cracked mirror", amountExclVatCents: 120_000 }] } })
  })
  it("requires the final reading when usage is contracted", () => {
    expect(inspectionBody({ ...ok, usageContracted: true })).toHaveProperty("error")
    expect(inspectionBody({ ...ok, usageContracted: true, finalReading: "5400" })).toMatchObject({ body: { finalReading: 5400 } })
  })
  it("refuses a half-filled damage line", () => {
    expect(inspectionBody({ ...ok, damage: [{ description: "Cracked mirror", amountRands: "" }] })).toHaveProperty("error")
    expect(inspectionBody({ ...ok, damage: [{ description: "", amountRands: "10" }] })).toHaveProperty("error")
  })
})
