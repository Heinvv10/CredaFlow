import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { formatMoney } from "@/lib/asset-finance/format"
import type { PortalRecoveryView } from "@/lib/asset-finance/recovery-view"
import { PortalRecoveryCard } from "./PortalRecoveryCard"

const view = (over: Partial<PortalRecoveryView> = {}): PortalRecoveryView => ({
  status: "VALUATION_NOTICE_ISSUED", recoveredOn: "2026-10-01", asset: "2022 TEST Excavator", valuationAmountCents: 80_000_000,
  notices: { valuation: true, final: false }, finalAccount: null, ...over,
})
const text = (v: PortalRecoveryView) => renderToStaticMarkup(<PortalRecoveryCard view={v} locale="en" />)

describe("PortalRecoveryCard", () => {
  it("shows the status, the valuation and the notices issued, and no account before the final one", () => {
    const out = text(view())
    expect(out).toContain("Valuation notice issued")
    expect(out).toContain(formatMoney(80_000_000))
    expect(out).toContain("Valuation notice")
    expect(out).not.toContain("Net proceeds")
  })

  it("prints no valuation, and no claim about one, when the server withholds it", () => {
    const out = text(view({ valuationAmountCents: null }))
    expect(out).not.toContain("Valuation<")
    expect(out.toLowerCase()).not.toContain("not yet valued")
    expect(out).toContain("Valuation notice")
    expect(out).toContain("Notices issued")
  })

  it("shows the final account with its cost lines and the shortfall owed", () => {
    const out = text(view({
      status: "SHORTFALL_OPEN", notices: { valuation: true, final: true },
      finalAccount: {
        grossProceedsCents: 60_000_000, deductedCostsCents: 1_000_000, netProceedsCents: 59_000_000, chargedCostsCents: 500_000, shortfallCents: 2_500_000, unrecoverableCostsCents: 0, surplusCents: 0,
        costs: [{ label: "Storage", grossCents: 1_000_000, treatment: "DEDUCT_FROM_PROCEEDS" }, { label: "Legal costs (taxed)", grossCents: 500_000, treatment: "CHARGE_TO_ACCOUNT" }],
        chargesFrozenUntil: "2026-11-20",
      },
    })).replace(/&nbsp;| /g, " ")
    expect(out).toContain("Shortfall you owe")
    expect(out).toContain(formatMoney(2_500_000).replace(/ /g, " "))
    expect(out).toContain("Storage")
    expect(out).toContain("Charged to the account")
    expect(out).not.toContain("Surplus due")
    expect(out).toContain("No further charges accrue")
  })

  it("prints the charged costs the account cannot carry only when there are any, apart from the shortfall owed", () => {
    const account = (unrecoverableCostsCents: number) => text(view({
      status: "SHORTFALL_OPEN", notices: { valuation: true, final: true },
      finalAccount: { grossProceedsCents: 60_000_000, deductedCostsCents: 0, netProceedsCents: 60_000_000, chargedCostsCents: 500_000, shortfallCents: 2_000_000, unrecoverableCostsCents, surplusCents: 0, costs: [], chargesFrozenUntil: null },
    }))
    expect(account(0)).not.toContain("not recoverable")
    const out = account(500_000)
    expect(out).toContain("Charged costs not recoverable on the account")
    expect(out).toContain("Shortfall you owe")
  })

  it("shows a surplus due to the borrower, and nothing about a buyer or a sale", () => {
    const out = text(view({
      status: "SURPLUS_HELD",
      finalAccount: { grossProceedsCents: 90_000_000, deductedCostsCents: 0, netProceedsCents: 90_000_000, chargedCostsCents: 0, shortfallCents: 0, unrecoverableCostsCents: 0, surplusCents: 4_000_000, costs: [], chargesFrozenUntil: null },
    }))
    expect(out).toContain("Surplus due to you")
    expect(out.toLowerCase()).not.toContain("buyer")
  })
})
