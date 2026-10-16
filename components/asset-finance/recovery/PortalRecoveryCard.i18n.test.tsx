import { createHash } from "node:crypto"
import type { RecoveryStatus } from "@prisma/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { PortalRecoveryView } from "@/lib/asset-finance/recovery-view"
import { formatIsoDate } from "@/lib/asset-finance/format"
import { CATALOGS } from "@/lib/i18n/catalog"
import { formatDay } from "@/lib/i18n/format"
import type { Locale } from "@/lib/i18n/locales"
import { PortalRecoveryCard } from "./PortalRecoveryCard"
import { STATUS_LABELS } from "./recovery-model"

// Synthetic views covering every status and every line the card can print.
const base: PortalRecoveryView = {
  status: "VALUATION_NOTICE_ISSUED", recoveredOn: "2026-10-01", asset: "2022 TEST Excavator", valuationAmountCents: 80_000_000,
  notices: { valuation: true, final: false }, finalAccount: null,
}
const account = (over: Partial<NonNullable<PortalRecoveryView["finalAccount"]>> = {}): NonNullable<PortalRecoveryView["finalAccount"]> => ({
  grossProceedsCents: 60_000_000, deductedCostsCents: 1_000_000, netProceedsCents: 59_000_000, chargedCostsCents: 500_000, shortfallCents: 2_500_000,
  unrecoverableCostsCents: 0, surplusCents: 0,
  costs: [{ label: "Storage", grossCents: 1_000_000, treatment: "DEDUCT_FROM_PROCEEDS" }, { label: "Legal costs (taxed)", grossCents: 500_000, treatment: "CHARGE_TO_ACCOUNT" }],
  chargesFrozenUntil: "2026-11-20", ...over,
})
const STATUSES: RecoveryStatus[] = ["RECOVERED", "VALUED", "VALUATION_NOTICE_ISSUED", "LISTED", "SOLD", "PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED", "SHORTFALL_OPEN", "SURPLUS_HELD", "CLOSED", "WITHDRAWN"]
const ENGLISH_STATUSES = ["VALUATION_NOTICE_ISSUED", "FINAL_NOTICE_ISSUED", "SHORTFALL_OPEN", "SURPLUS_HELD"] as const
const TRANSLATED_STATUSES = ["RECOVERED", "VALUED", "LISTED", "SOLD", "PROCEEDS_APPLIED", "CLOSED", "WITHDRAWN"] as const
const final = { notices: { valuation: true, final: true } }
const CASES: Record<string, PortalRecoveryView> = {
  ...Object.fromEntries(STATUSES.map((status) => [`status ${status}`, { ...base, status }])),
  "no valuation, no notices": { ...base, status: "RECOVERED", valuationAmountCents: null, notices: { valuation: false, final: false } },
  "shortfall with costs and freeze": { ...base, ...final, status: "SHORTFALL_OPEN", finalAccount: account() },
  "unrecoverable costs": { ...base, ...final, status: "SHORTFALL_OPEN", finalAccount: account({ unrecoverableCostsCents: 500_000, chargesFrozenUntil: null }) },
  "surplus": { ...base, ...final, status: "SURPLUS_HELD", finalAccount: account({ shortfallCents: 0, surplusCents: 4_000_000, costs: [] }) },
  "nothing owed": { ...base, ...final, status: "CLOSED", finalAccount: account({ shortfallCents: 0, surplusCents: 0, chargesFrozenUntil: null }) },
}

// sha-256 of the card's English markup for each case, rendered by the card before
// it was translated (main 1d4f6557): English output must not change.
const ENGLISH_BEFORE: Record<string, string> = {
  "status RECOVERED": "20a0551669a86c3ea0163421ea94f6f039277305676952fa59db001301f81db3",
  "status VALUED": "3d140a950bb3cebb7b80cdeb4c4da004a8add40ad121551f5608fb853ad89ead",
  "status VALUATION_NOTICE_ISSUED": "72bbd5f0aa6cbbf978074efb9434ccd3e811ced358745097ac0dde291f2d357d",
  "status LISTED": "9b0ec4bc755090580dbba9163cccda8c19f3feea28f1e9e1920da379bd5a8f2d",
  "status SOLD": "6a9c09714ff4270a143aa04e39d72adc7d773dc6df62c1dd561938ecb355ea8d",
  "status PROCEEDS_APPLIED": "ce7c58227db8b554317b3b583f129c69b41c4599eb686d2d2b6e3ccc97f55118",
  "status FINAL_NOTICE_ISSUED": "bb8b193280452cb5be83d2fe3e7ef04613fe2be15c3afdef90b56ad92b59bbf9",
  "status SHORTFALL_OPEN": "ad9bf4ef8de7972e3a8976fe90503002c13e958dc9174215bd8b8b9d9adf2d02",
  "status SURPLUS_HELD": "539a47c4bf47579c22ae5fbe7ae69b16647bd854b3f6bd8f404319419becdc5d",
  "status CLOSED": "54cc36eb8795a76a11a1dff41f5b42d4b4c42fd6bc68f58ab0017fc1f59be397",
  "status WITHDRAWN": "83eeb4f29b5528f375c7f5563a4bef93e10063ee3d63f2fb986f93e595da4d6e",
  "no valuation, no notices": "f9fc0f64092dcae76c8413c2c3131ddbd5fdf0426a3eb31f0168ee37cead68cf",
  "shortfall with costs and freeze": "0711ecf8cef783662ec055e7a728bbc5bdcc2373c7fb61664db5b5ffb84d3527",
  "unrecoverable costs": "85927e89f7d7e6c0c5305bf546a3a10857b901175a97431abb2c8c242e6bfcaa",
  "surplus": "bc935d4bef4b7192a6be58a60cba445df4e097824bebd691bb21dd7bf4945ad9",
  "nothing owed": "028ebfe740aa132fb5f6f2e55b371d22405d8b5971a8afc6de4a0a01a6640eb4",
}

const html = (view: PortalRecoveryView, locale: Locale) => renderToStaticMarkup(<PortalRecoveryCard view={view} locale={locale} />)
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

describe("PortalRecoveryCard in the borrower's language", () => {
  it.each(Object.keys(CASES))("English is byte-identical to the card before translation: %s", (name) => {
    expect(sha(html(CASES[name], "en"))).toBe(ENGLISH_BEFORE[name])
  })

  it.each(["af", "zu", "xh"] as const)("%s: the heading and the neutral statuses come from the catalogue", (locale) => {
    const m = CATALOGS[locale].portalRecovery
    const out = html(CASES["shortfall with costs and freeze"], locale)
    expect(out).toContain(m.title)
    expect(out).toContain(m.noticesIssued)
    expect(out).toContain(m.description.replace("{asset}", "2022 TEST Excavator").replace("{date}", formatDay("2026-10-01T12:00:00+02:00", locale)))
    expect(out).not.toContain("Recovery of your asset")
    expect(html(CASES["no valuation, no notices"], locale)).toContain(m.noneYet)
    for (const status of TRANSLATED_STATUSES) expect(html({ ...base, status }, locale)).toContain(m[`status_${status}`])
  })

  // Statutory and collections text is never translated (lib/i18n/.claude.md): every line
  // that mirrors the s127/s131 notices or states what is owed prints in English. Each is
  // matched as a whole element text (">…<"), so "Valuation" is not found inside "Valuation notice".
  it.each(["af", "zu", "xh"] as const)("%s: the notice, final-account and owed lines stay English", (locale) => {
    const text = (view: PortalRecoveryView) => html(view, locale).replace(/&nbsp;|\u00a0/g, " ")
    const shortfall = text(CASES["shortfall with costs and freeze"])
    for (const english of [
      "Valuation", "Valuation notice, Final notice", "Sale proceeds", "Costs deducted from the proceeds", "Net proceeds", "Costs charged to the account",
      "Shortfall you owe", "Recovery costs", "Storage", "Legal costs (taxed)", "Deducted from the proceeds", "Charged to the account",
      `No further charges accrue on the account until ${formatIsoDate("2026-11-20")}.`, "R 25,000.00", "Shortfall open",
    ]) expect(shortfall, english).toContain(`>${english}<`)
    expect(text(CASES["unrecoverable costs"])).toContain(">Charged costs not recoverable on the account<")
    expect(text(CASES.surplus)).toContain(">Surplus due to you<")
    expect(text(CASES.surplus)).toContain(">Surplus held<")
    expect(text(CASES["nothing owed"])).toContain(">Nothing owed either way<")
    expect(text(CASES["nothing owed"])).toContain(">Balance<")
    for (const status of ENGLISH_STATUSES) expect(text({ ...base, status })).toContain(`>${STATUS_LABELS[status]}<`)
  })

  it("prints the English label for a status the catalogue does not know, rather than failing", () => {
    const out = html({ ...base, status: "SOMETHING_NEW" as RecoveryStatus }, "af")
    expect(out).toContain(CATALOGS.af.portalRecovery.title)
  })
})
