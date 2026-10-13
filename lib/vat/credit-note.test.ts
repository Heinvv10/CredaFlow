import { describe, expect, it } from "vitest"
import { creditNoteVat } from "./credit-note"

// Two lines whose per-line VAT (150 + 2) exceeds VAT on the total (151).
const INVOICE = { exclVatCents: 1009, vatCents: 152, vatRate: "0.1500" }

describe("creditNoteVat", () => {
  it("credits the whole remaining VAT when the whole remaining value is credited", () => {
    expect(creditNoteVat(INVOICE, { exclVatCents: 0, vatCents: 0 }, 1009)).toBe(152)
    expect(creditNoteVat(INVOICE, { exclVatCents: 10, vatCents: 2 }, 999)).toBe(150)
  })

  it("computes a partial credit's VAT half-up at the invoice's rate", () => {
    expect(creditNoteVat(INVOICE, { exclVatCents: 0, vatCents: 0 }, 10)).toBe(2) // 1.50
    expect(creditNoteVat(INVOICE, { exclVatCents: 0, vatCents: 0 }, 3)).toBe(0) // 0.45
  })

  it("refuses more than is still creditable, and a non-positive amount", () => {
    expect(() => creditNoteVat(INVOICE, { exclVatCents: 1000, vatCents: 150 }, 10)).toThrow(/exceeds/)
    expect(() => creditNoteVat(INVOICE, { exclVatCents: 0, vatCents: 0 }, 0)).toThrow(RangeError)
  })
})
