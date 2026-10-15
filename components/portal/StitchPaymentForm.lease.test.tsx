import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { formatZAR } from "@/lib/loan-calculator"
import { I18nProvider } from "@/lib/i18n/client"
import { CATALOGS } from "@/lib/i18n/catalog"
import { StitchPaymentForm, type LoanOption } from "./StitchPaymentForm"

// A lease's figure is the rentals outstanding, not a settlement. English must
// read exactly as main's wording; other languages come from the catalogue.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

const option = (id: string, reference: string, lease: boolean): LoanOption => ({
  id, reference, outstandingPrincipal: 100_000, nextInstallment: 20_000, settlementAmount: 123_456,
  paymentDefault: 20_000, chargeLines: [], lease,
})
const AMOUNT = formatZAR(123_456)
const text = (html: string) => html.replace(/<!-- -->/g, "")

describe("StitchPaymentForm settlement wording", () => {
  it("English: a lease shows rentals outstanding, a loan its settlement", () => {
    const html = text(renderToStaticMarkup(<StitchPaymentForm loans={[option("a", "LS-1", true), option("b", "LN-2", false)]} />))
    expect(html).toContain(`>LS-1 — ${AMOUNT} rentals outstanding</option>`)
    expect(html).toContain(`>LN-2 — ${AMOUNT} settlement</option>`)
    expect(html).toContain("Rentals outstanding: <strong")
    expect(html).not.toContain("Current settlement")
  })

  it("English: a loan selected shows the current settlement", () => {
    const html = text(renderToStaticMarkup(<StitchPaymentForm loans={[option("b", "LN-2", false)]} />))
    expect(html).toContain("Current settlement: <strong")
  })

  it("Afrikaans: the lease wording comes from the catalogue", () => {
    const html = text(renderToStaticMarkup(
      <I18nProvider locale="af" messages={{ portalPayment: CATALOGS.af.portalPayment, portalLabels: CATALOGS.af.portalLabels }}>
        <StitchPaymentForm loans={[option("a", "LS-1", true), option("b", "LN-2", false)]} />
      </I18nProvider>,
    ))
    expect(html).toContain(`>LS-1 — ${AMOUNT} uitstaande huurgeld</option>`)
    expect(html).toContain("Uitstaande huurgeld: <strong")
  })
})
