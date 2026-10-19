import { describe, expect, it } from "vitest"
import { createTranslator } from "./translate"

// Row 118: the overview's "Current account amount" panel label and the loan
// detail's label were copied into the Afrikaans catalogue in English.
describe("Afrikaans account amount labels", () => {
  it("translates the overview panel label", () => {
    expect(createTranslator("af", "portalHome")("currentAccountAmount")).toBe("Huidige rekeningbedrag")
  })

  it("translates the loan detail amount label but keeps overdue and settlement wording English", () => {
    const t = createTranslator("af", "portalLoans")
    expect(t("currentAccountAmount")).toBe("Huidige rekeningbedrag")
    // Overdue / settlement text is collections and statutory wording (lib/i18n/.claude.md).
    expect(t("overdueNow")).toBe("Overdue now, including default charges")
    expect(t("settlementAsOf", { date: "x" })).toBe("Calculated settlement as of x")
  })
})
