import { describe, expect, it } from "vitest"
import { planBooking } from "@/lib/asset-finance/booking-plan"
import { computeCreditMemo } from "@/lib/asset-finance/credit-memo"
import { solveStructure } from "@/lib/asset-finance/structure"
import { annualSeasonal } from "@/lib/asset-finance/structure-presets"
import { PAR30_LIMIT } from "../../scripts/demo/simulate/book-health"
import { COMPANY_DEAL, CREDIT_MEMO, EXCAVATOR } from "./asset-finance-data"

describe("performing company fixture alongside the legally completed recovery book", () => {
  it("retains PAR headroom using booked remaining principal, not original amounts", () => {
    const gross = EXCAVATOR.cashPriceExclVatCents + EXCAVATOR.vatCents
    expect(EXCAVATOR.vatCents).toBe(EXCAVATOR.cashPriceExclVatCents * 0.15)
    expect(COMPANY_DEAL.depositCents).toBe(gross * 0.1)
    expect(COMPANY_DEAL.balloonCents).toBe(gross * 0.2)
    const result = solveStructure({
      cashPriceCents: gross, depositCents: COMPANY_DEAL.depositCents,
      tradeInCents: 0, financedFeesCents: 0, balloonCents: COMPANY_DEAL.balloonCents,
      startDate: "2026-04-01", ratePath: [{ effectiveDate: "2026-04-01", annualRate: 0.1175 }],
      weights: annualSeasonal(60, 5, [4, 5, 6], 3, 0.5),
    })
    const booked = planBooking({ result, startDate: "2026-04-01", balloonCents: COMPANY_DEAL.balloonCents, payoutCents: gross - COMPANY_DEAL.depositCents })
    // The seed's first early receipt plus five scheduled receipts by Oct 18.
    const paid = booked.records.filter(row => row.dueDate <= new Date("2026-10-18"))
    expect(paid).toHaveLength(6)
    const outstandingPrincipal = booked.principal - paid.reduce((sum, row) => sum + row.principalDue, 0)
    // Actual full-window c51 rehearsal after ordinary, currently dated TLB
    // recovery completion: fixed other collectible principal and PAR30 cents.
    const otherBookCents = 141_321_818
    const par30Cents = 64_134_580
    expect(PAR30_LIMIT).toBe(0.15)
    expect(par30Cents / (otherBookCents + outstandingPrincipal)).toBeLessThanOrEqual(PAR30_LIMIT - 0.005)
    expect(outstandingPrincipal).toBe(304_970_054)
    const memo = computeCreditMemo(CREDIT_MEMO, result.rows)
    expect(memo.dscr).toBe("3.0551")
    expect(memo.gearing).toBe("0.3889")
  })
})
