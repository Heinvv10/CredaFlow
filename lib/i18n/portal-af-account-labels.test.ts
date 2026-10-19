import { describe, expect, it } from "vitest"
import { createTranslator } from "./translate"

// Row 118: the overview's "Current account amount" panel label and the loan
// detail's amount labels were copied into the Afrikaans catalogue in English.
describe("Afrikaans account amount labels", () => {
  it("translates the overview panel label", () => {
    expect(createTranslator("af", "portalHome")("currentAccountAmount")).toBe("Huidige rekeningbedrag")
  })

  it("translates the loan detail amount labels", () => {
    const t = createTranslator("af", "portalLoans")
    expect(t("currentAccountAmount")).toBe("Huidige rekeningbedrag")
    expect(t("overdueNow")).toBe("Nou agterstallig, insluitend verstekkoste")
    expect(t("remainingContractual")).toBe("Oorblywende kontraktuele paaiemente")
    expect(t("settlementAsOf", { date: "14 Okt. 2026" })).toBe("Berekende vereffening soos op 14 Okt. 2026")
  })
})
