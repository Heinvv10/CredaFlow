import { describe, expect, it } from "vitest"
import { RATE_SCALE } from "@/lib/vat/amounts"
import { repossessionVatEvent, resaleOutputTax } from "./recovery-vat"

const RATE = 1500
// Cash price R2,300.00 incl. VAT (R2,000.00 + R300.00); R1,150.00 of it unpaid.
const deal = { cashPriceInclVatCents: 230_000, unpaidCashPriceCents: 115_000, vatRateTenThousandths: RATE }

describe("repossessionVatEvent", () => {
  it("instalment sale, vendor debtor: deemed supply of the unpaid cash price, input tax 15/115 of it", () => {
    const event = repossessionVatEvent({ ...deal, contractType: "INSTALMENT_SALE", debtorVatVendor: true })
    expect(event).toMatchObject({ kind: "REPOSSESSION_DEEMED_SUPPLY", deemedSupplyValueCents: 115_000, inputTaxClaimCents: 15_000 })
    expect(event.basis).toMatch(/8\(10\)/)
    expect(event.basis).toMatch(/tax invoice/i)
  })

  it("instalment sale, non-vendor debtor: same figures, notional input tax basis", () => {
    const event = repossessionVatEvent({ ...deal, contractType: "INSTALMENT_SALE", debtorVatVendor: false })
    expect(event).toMatchObject({ kind: "REPOSSESSION_DEEMED_SUPPLY", deemedSupplyValueCents: 115_000, inputTaxClaimCents: 15_000 })
    expect(event.basis).toMatch(/16\(3\)/)
  })

  it("finance lease behaves as an instalment sale", () => {
    for (const debtorVatVendor of [true, false]) {
      expect(repossessionVatEvent({ ...deal, contractType: "FINANCE_LEASE", debtorVatVendor })).toMatchObject({
        kind: "REPOSSESSION_DEEMED_SUPPLY", deemedSupplyValueCents: 115_000, inputTaxClaimCents: 15_000,
      })
    }
  })

  it("caps the deemed value at the VAT-inclusive cash price", () => {
    expect(repossessionVatEvent({
      ...deal, unpaidCashPriceCents: 300_000, contractType: "INSTALMENT_SALE", debtorVatVendor: true,
    })).toMatchObject({ deemedSupplyValueCents: 230_000, inputTaxClaimCents: 30_000 })
  })

  it("rounds the input tax half-up to the cent", () => {
    // 10001 * 15 / 115 = 1304.48 -> 1304; 10010 * 15 / 115 = 1305.65 -> 1306
    const at = (unpaidCashPriceCents: number) => repossessionVatEvent({
      ...deal, unpaidCashPriceCents, contractType: "INSTALMENT_SALE", debtorVatVendor: true,
    }).inputTaxClaimCents
    expect(at(10_001)).toBe(1_304)
    expect(at(10_010)).toBe(1_306)
  })

  it("nothing unpaid means no deemed supply value and no input tax", () => {
    expect(repossessionVatEvent({
      ...deal, unpaidCashPriceCents: 0, contractType: "INSTALMENT_SALE", debtorVatVendor: true,
    })).toMatchObject({ deemedSupplyValueCents: 0, inputTaxClaimCents: 0 })
  })

  it("operating and full-maintenance leases: lessor resale, no deemed supply", () => {
    for (const contractType of ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] as const) {
      for (const debtorVatVendor of [true, false]) {
        const event = repossessionVatEvent({ ...deal, contractType, debtorVatVendor })
        expect(event).toMatchObject({ kind: "LESSOR_RESALE", deemedSupplyValueCents: 0, inputTaxClaimCents: 0 })
        expect(event.basis).toMatch(/lessor/i)
      }
    }
  })

  it("rejects a non-credit contract type, bad cents and a bad rate", () => {
    const ok = { ...deal, debtorVatVendor: true, contractType: "INSTALMENT_SALE" as const }
    expect(() => repossessionVatEvent({ ...ok, contractType: "LOAN" as never })).toThrow(RangeError)
    expect(() => repossessionVatEvent({ ...ok, unpaidCashPriceCents: -1 })).toThrow(RangeError)
    expect(() => repossessionVatEvent({ ...ok, cashPriceInclVatCents: 1.5 })).toThrow(RangeError)
    expect(() => repossessionVatEvent({ ...ok, vatRateTenThousandths: RATE_SCALE })).toThrow(RangeError)
  })

  it("equals the direct half-up of value x rate / (10000 + rate) for every amount at 15%", () => {
    for (let cents = 0; cents <= 50_000; cents++) {
      const direct = Math.floor((2 * cents * RATE + (RATE_SCALE + RATE)) / (2 * (RATE_SCALE + RATE)))
      const event = repossessionVatEvent({
        contractType: "INSTALMENT_SALE", debtorVatVendor: false, unpaidCashPriceCents: cents,
        cashPriceInclVatCents: 50_000, vatRateTenThousandths: RATE,
      })
      expect(event.inputTaxClaimCents).toBe(direct)
    }
  })
})

describe("resaleOutputTax", () => {
  it("is the VAT contained in the inclusive resale price", () => {
    expect(resaleOutputTax(115_000, RATE)).toBe(15_000)
    expect(resaleOutputTax(10_001, RATE)).toBe(1_304)
    expect(resaleOutputTax(0, RATE)).toBe(0)
  })

  it("rejects bad cents and a bad rate", () => {
    expect(() => resaleOutputTax(-1, RATE)).toThrow(RangeError)
    expect(() => resaleOutputTax(100, -1)).toThrow(RangeError)
  })
})
