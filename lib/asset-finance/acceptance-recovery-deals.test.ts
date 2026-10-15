import { describe, expect, it } from "vitest"
import { RECOVERY_DEALS } from "./__fixtures__/acceptance-recovery-deals"
import { costTotals, recoveryOutcome } from "./recovery-outcome"
import { repossessionVatEvent, resaleOutputTax } from "./recovery-vat"

const RATE = 1500

describe("slice-4 recovery acceptance deals (independently worked)", () => {
  it("has two synthetic deals per route", () => {
    const perRoute = new Map<string, number>()
    for (const deal of RECOVERY_DEALS) perRoute.set(deal.route, (perRoute.get(deal.route) ?? 0) + 1)
    expect([...perRoute.values()]).toEqual([2, 2, 2, 2])
  })

  for (const deal of RECOVERY_DEALS) {
    it(`${deal.id}: costs, proceeds, shortfall/surplus and VAT to the cent`, () => {
      for (const cost of deal.costs) {
        expect(Math.floor((cost.netCents * RATE) / 10_000 + 0.5)).toBe(cost.vatCents)
        expect(cost.netCents + cost.vatCents).toBe(cost.grossCents)
      }
      const totals = costTotals(deal.costs)
      expect(totals).toEqual({ deducted: deal.expected.deductedCostsCents, charged: deal.expected.chargedCostsCents })
      expect(recoveryOutcome({
        settlementDueCents: deal.settlementDueCents, grossProceedsCents: deal.grossProceedsCents,
        deductedCostsCents: totals.deducted, chargedCostsCents: totals.charged,
      })).toEqual({
        netProceedsCents: deal.expected.netProceedsCents, paymentCents: deal.expected.paymentCents,
        shortfallCents: deal.expected.shortfallCents, surplusCents: deal.expected.surplusCents,
      })
      const vat = repossessionVatEvent({
        contractType: deal.contractType, debtorVatVendor: deal.debtorVatVendor,
        unpaidCashPriceCents: deal.unpaidCashPriceCents, cashPriceInclVatCents: deal.cashPriceInclVatCents,
        vatRateTenThousandths: RATE,
      })
      expect({ kind: vat.kind, deemedSupplyValueCents: vat.deemedSupplyValueCents, inputTaxClaimCents: vat.inputTaxClaimCents })
        .toEqual(deal.expected.vat)
      const output = resaleOutputTax(deal.grossProceedsCents, RATE)
      expect({ exclVatCents: deal.grossProceedsCents - output, vatCents: output }).toEqual(deal.expected.resale)
    })
  }
})
