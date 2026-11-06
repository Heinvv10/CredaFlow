import { afterEach, describe, expect, it } from "vitest"
import { createTranslator } from "./translate"
import { LOCALES } from "./locales"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { activeCurrencySymbol } from "@/lib/utils"

afterEach(() => resetActiveJurisdiction())

const LABELS = [
  ["portalApply", "incomeR"],
  ["portalApply", "expensesR"],
  ["portalApply", "debtR"],
  ["portalApply", "amountBetween"],
  ["websiteApply", "netIncome"],
  ["websiteApply", "expenses"],
  ["portalPayment", "amountPaid"],
] as const

function render(locale: (typeof LOCALES)[number], ns: (typeof LABELS)[number][0], key: string): string {
  const t = createTranslator(locale, ns) as unknown as (k: string, v: Record<string, string>) => string
  return t(key, { symbol: activeCurrencySymbol(), min: "MIN", max: "MAX" })
}

describe("form labels carry the active currency symbol", () => {
  for (const locale of LOCALES) {
    for (const [ns, key] of LABELS) {
      it(`${locale} ${ns}.${key}: (R) for ZA, (M) for LS, never both`, () => {
        const za = render(locale, ns, key)
        expect(za).toContain("(R)")
        setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
        const ls = render(locale, ns, key)
        expect(ls).toContain("(M)")
        expect(ls).not.toContain("(R)")
        expect(ls.replace("(M)", "(R)")).toBe(za)
      })
    }
  }
})
