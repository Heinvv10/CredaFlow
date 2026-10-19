import { describe, expect, it } from "vitest"
import { createTranslator } from "./translate"
import { paymentMethodLabel, productNameLabel } from "./portal-labels"

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

// Row 118: the portal showed the seeded product name "Personal Loan" in English
// under Afrikaans. Only an unrenamed default is translated; a lender's own name stays.
describe("productNameLabel", () => {
  it("translates the default product names", () => {
    const af = createTranslator("af", "portalLabels")
    expect(productNameLabel(af, "Personal Loan")).toBe("Persoonlike lening")
    expect(productNameLabel(af, "30-Day Micro Loan")).toBe("30-dae-mikrolening")
    expect(productNameLabel(af, "Purchase Order Funding")).toBe("Bestellingsfinansiering")
  })

  it("leaves English and a lender's own product name unchanged", () => {
    expect(productNameLabel(createTranslator("en", "portalLabels"), "Personal Loan")).toBe("Personal Loan")
    expect(productNameLabel(createTranslator("af", "portalLabels"), "Acme Flex Loan")).toBe("Acme Flex Loan")
  })
})
