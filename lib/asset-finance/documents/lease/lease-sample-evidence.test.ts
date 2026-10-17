import { describe, expect, it } from "vitest"
import { QUOTE, QUOTE_ROW, QUOTE_RENTALS } from "./lease-docs.fixture"

describe("synthetic CPA termination sample evidence", () => {
  it("uses twenty business days including the observed Human Rights Day holiday", () => {
    expect(QUOTE.quotedOn).toBe("2027-02-23")
    expect(QUOTE.terminationDate).toBe("2027-03-24")
    expect(QUOTE_ROW.terminationDate.toISOString().slice(0, 10)).toBe("2027-03-24")
  })
  it("prices the stated remaining synthetic rentals and reconciles charge, VAT and arrears", () => {
    let previous = Date.parse("2027-03-24")
    let discount = 1
    let pv = 0
    for (const row of QUOTE_RENTALS) {
      const due = Date.parse(row.dueDate)
      discount *= 1 + 0.12 * (due - previous) / 86_400_000 / 365
      pv += 3_000_000 / discount
      previous = due
    }
    expect(QUOTE_RENTALS).toHaveLength(14)
    expect(QUOTE_RENTALS[0].dueDate).toBe("2027-04-15")
    expect(QUOTE_RENTALS.at(-1)?.dueDate).toBe("2028-05-15")
    expect(QUOTE.pvCents).toBe(Math.round(pv))
    expect(QUOTE.invoiceExclVatCents).toBe(Math.round(pv) - 12_000_000 + 500_000)
    expect(QUOTE.invoiceVatCents).toBe(Math.round(QUOTE.invoiceExclVatCents * 0.15))
    expect(QUOTE.totalCents).toBe(QUOTE.invoiceExclVatCents + QUOTE.invoiceVatCents + 1_234_500)
  })
})
