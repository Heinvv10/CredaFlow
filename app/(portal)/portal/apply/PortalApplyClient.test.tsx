import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

import { PortalApplyClient } from "./PortalApplyClient"
import { computeQualification } from "@/lib/qualify"
import { formatZAR } from "@/lib/utils"

// Thembeka-shaped profile from the audit (NDI R11,762.35).
const client = { firstName: "Thembeka", monthlyIncome: 2_250_000, monthlyExpenses: 960_000, existingDebt: 113_765 }
const bounds = {
  micro: { minAmount: 50_000, maxAmount: 200_000 },
  personal: { minAmount: 200_000, maxAmount: 10_000_000 },
  po: { minAmount: 1_000_000, maxAmount: 50_000_000 },
}
const productRanges = { micro: "R500 – R2,000", personal: "R2,000 – R100,000", po: "R10,000 – R500,000" }

function render(
  recentDecline: { id: string; reference: string; decidedOn: string } | null = null,
  ownLenderArrears: { days: number; amountCents: number } | null = null,
) {
  const qualification = computeQualification(client.monthlyIncome, client.monthlyExpenses, client.existingDebt, bounds)
  return renderToStaticMarkup(
    <PortalApplyClient client={client} qualification={qualification} productRanges={productRanges}
      bounds={bounds} recentDecline={recentDecline} ownLenderArrears={ownLenderArrears} />,
  ).replace(/<!-- -->/g, "")
}

describe("PortalApplyClient", () => {
  it("never shows a micro-loan figure above the product's maximum, in the scenarios either", () => {
    const html = render()
    const scenarios = html.slice(html.indexOf("Explore Scenarios"))
    const micro = scenarios.slice(scenarios.indexOf("Micro Loan</p>"))
    expect(micro.slice(0, micro.indexOf("</div>"))).toContain(formatZAR(200_000))
  })

  it("tells a client declined in the last 30 days so, instead of 'You qualify' and Best Match", () => {
    const html = render({ id: "app-9", reference: "APP-MNSKSZ0Y-GCRU", decidedOn: "16 Oct 2026" })
    expect(html).toContain("Your recent application was declined")
    expect(html).toContain("APP-MNSKSZ0Y-GCRU")
    expect(html).toContain('href="/portal/applications/app-9"')
    expect(html).not.toContain("Best Match")
    expect(html).not.toContain("You qualify for up to")
    expect(html).not.toContain("here&#x27;s what you qualify for")
  })

  it("shows the qualification to a client with no recent decline", () => {
    const html = render()
    expect(html).toContain("Best Match")
    expect(html).toContain("You qualify for up to")
  })

  it("shows a PO range subject to full borrower-affordability assessment", () => {
    const html = render()
    const po = html.slice(html.indexOf("PO Funding</h3>"))
    const card = po.slice(0, po.indexOf("Apply for"))
    expect(card).not.toContain("You qualify for up to")
    expect(card).toContain("R10,000 – R500,000")
    expect(card).toContain("confirmed purchase order")
    expect(card).toContain("income, expenses and existing debts")
    expect(card).toContain("full scheduled repayment")
    expect(card).not.toContain("not sized on your salary")
  })

  it("shows the scenario panel's NDI and max instalment to the cent, matching the top panel", () => {
    const html = render()
    const q = computeQualification(client.monthlyIncome, client.monthlyExpenses, client.existingDebt, bounds)
    const scenarios = html.slice(html.indexOf("Explore Scenarios"))
    expect(scenarios).toContain(formatZAR(q.ndi))
    expect(scenarios).toContain(formatZAR(q.maxInstalment))
  })

  it("tells a client behind on a loan with us so, and says nothing to one who is up to date", () => {
    const html = render(null, { days: 60, amountCents: 205_834 })
    expect(html).toContain(`Your loan with us is 60 days overdue (${formatZAR(205_834)})`)
    expect(html).toContain("included in your existing debt")
    expect(render()).not.toContain('data-testid="own-lender-arrears"')
  })
})
