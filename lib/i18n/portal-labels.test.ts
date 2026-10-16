import { describe, expect, it } from "vitest"
import { createTranslator } from "./translate"
import { paymentMethodLabel } from "./portal-labels"

// Fair Score audit 2026-10-16: the statement showed "Eft", the overview "eft".
describe("paymentMethodLabel", () => {
  const en = createTranslator("en", "portalLabels")

  it("writes EFT and Debit order as a borrower reads them", () => {
    expect(paymentMethodLabel(en, "EFT")).toBe("EFT")
    expect(paymentMethodLabel(en, "DEBIT_ORDER")).toBe("Debit order")
    expect(paymentMethodLabel(en, "CASH")).toBe("Cash")
    expect(paymentMethodLabel(en, "CARD")).toBe("Card")
  })

  it.each(["af", "zu", "xh"] as const)("%s keeps the acronym EFT upper case", (locale) => {
    expect(paymentMethodLabel(createTranslator(locale, "portalLabels"), "EFT")).toBe("EFT")
  })
})
