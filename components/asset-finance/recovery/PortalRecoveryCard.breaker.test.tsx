import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { PortalRecoveryView } from "@/lib/asset-finance/recovery-view"
import type { Locale } from "@/lib/i18n/locales"
import { PortalRecoveryCard } from "./PortalRecoveryCard"

const view: PortalRecoveryView = {
  status: "SHORTFALL_OPEN", recoveredOn: "2026-10-01", asset: "2022 TEST Excavator", valuationAmountCents: 80_000_000,
  notices: { valuation: true, final: true },
  finalAccount: {
    grossProceedsCents: 60_000_000, deductedCostsCents: 1_000_000, netProceedsCents: 59_000_000, chargedCostsCents: 500_000, shortfallCents: 2_500_000,
    unrecoverableCostsCents: 100, surplusCents: 0, chargesFrozenUntil: "2026-11-20",
    costs: [{ label: "Storage", grossCents: 1_000_000, treatment: "DEDUCT_FROM_PROCEEDS" }],
  },
}
const html = (v: PortalRecoveryView, locale: string) => renderToStaticMarkup(<PortalRecoveryCard view={v} locale={locale as Locale} />).replace(/<!-- -->/g, "")
const ENGLISH = ["Valuation notice, Final notice", "Sale proceeds", "Net proceeds", "Costs charged to the account", "Shortfall you owe", "No further charges accrue on the account until", "Recovery costs", "Shortfall open", "Deducted from the proceeds"]

describe("REPRO F4 breaker", () => {
  it.each(["en", "af", "zu", "xh"])("English-kept lines are English under %s", (locale) => {
    const out = html(view, locale)
    for (const s of ENGLISH) expect(out, s).toContain(s)
    expect(out).toMatch(/20 November 2026|20 Nov/)
  })
  it.each(["af", "zu", "xh"])("%s: the recovered-on date in the description has no raw placeholder and no 'Invalid'", (locale) => {
    const out = html({ ...view, status: "LISTED", finalAccount: null }, locale)
    expect(out).not.toMatch(/\{|Invalid|undefined|NaN/)
  })
  it("F4-a (hypothesis, unreachable via getLocale which gates on isLocale): an unknown locale reaching the card crashes instead of falling back to English", () => {
    expect(() => html(view, "fr")).not.toThrow()
  })
  it("F4-b: a date-less / odd recoveredOn does not crash the translated description", () => {
    expect(() => html({ ...view, recoveredOn: "2026-02-30" }, "af")).not.toThrow()
  })
})
