import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { formatMoney } from "@/lib/asset-finance/format"
import type { PortalLeaseView } from "@/lib/asset-finance/portal-lease"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
// The end-of-term window constant lives in a module with server-only imports (see portal-lease-view.test.ts).
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))
vi.mock("@/lib/asset-finance/lease-portal-route", () => ({ clientLeaseRefusal: vi.fn() }))
vi.mock("@/lib/asset-finance/meter-readings", () => ({ recordMeterReading: vi.fn() }))

import { PortalLeaseDetail } from "./PortalLeaseDetail"

const rental = (periodNo: number, over: Partial<PortalLeaseView["rentals"][number]> = {}): PortalLeaseView["rentals"][number] => ({
  id: `r${periodNo}`, periodNo, dueDate: `2027-0${periodNo}-01`, rentalExclVatCents: 100_000, maintenanceExclVatCents: 10_000, vatCents: 16_500, totalCents: 126_500,
  paidCents: 0, outstandingCents: 126_500, state: "PENDING", invoice: null, ...over,
})

function view(over: Partial<PortalLeaseView> = {}): PortalLeaseView {
  return {
    today: "2027-03-15",
    loan: { id: "L1", reference: "TEST-LS-1", status: "ACTIVE", contractType: "OPERATING_LEASE", startDate: "2027-01-01", maturityDate: "2029-12-31" },
    entity: { id: "e1", legalName: "TEST Lessee (Pty) Ltd" },
    asset: { assetClass: "TRUCK", make: "Synthetic", model: "Hauler", year: 2026, serialNumber: "SYN-001", registrationNumber: null },
    rentals: [
      rental(1, { paidCents: 126_500, outstandingCents: 0, state: "PAID", invoice: { id: "inv-1", invoiceNumber: "TI-0001" } }),
      rental(2, { state: "OVERDUE", invoice: { id: "inv-2", invoiceNumber: "TI-0002" } }),
      rental(3),
    ],
    arrearsCents: 126_500, nextRental: { dueDate: "2027-03-01", amountCents: 126_500 },
    fund: null, meter: null,
    termination: { penaltyConfigured: true, latestQuote: null },
    endOfTerm: { chosen: null, valuation: null },
    ...over,
  }
}

const render = (v: PortalLeaseView, documents?: Parameters<typeof PortalLeaseDetail>[0]["documents"]) =>
  renderToStaticMarkup(<PortalLeaseDetail view={v} back={{ href: "/portal/loans", label: "Back" }} documents={documents} />).replace(/<!-- -->/g, "")

const fml = view({
  loan: { id: "L1", reference: "TEST-LS-2", status: "ACTIVE", contractType: "FULL_MAINTENANCE_LEASE", startDate: "2027-01-01", maturityDate: "2029-12-31" },
  fund: {
    balanceCents: 30_000, riskModel: "LESSEE_SETTLED",
    claims: [{ id: "c1", submittedOn: "2027-02-10T08:00:00.000Z", provider: "TEST Workshop", description: "Synthetic brake service", amountExclVatCents: 5_000, status: "PAID" }],
  },
  meter: { unit: "KM", latest: { readingDate: "2027-03-01", value: 9_000 } },
})

describe("PortalLeaseDetail", () => {
  it("lists each rental with its amounts, state and a download link only for an issued tax invoice", () => {
    const html = render(view())
    expect(html).toContain("/api/portal/asset-finance/leases/L1/tax-invoices/inv-1?download=1")
    expect(html).toContain("/api/portal/asset-finance/leases/L1/tax-invoices/inv-2?download=1")
    expect(html).not.toContain("tax-invoices/inv-3")
    expect(html).toContain("TI-0001")
    expect(html).toContain("Not yet issued")
    expect(html).toContain("Overdue")
    expect(html).toContain("Truck")
    expect(html).toContain(formatMoney(126_500))
  })

  it("shows the fund balance and claims history on a full-maintenance lease only", () => {
    const html = render(fml)
    expect(html).toContain("Maintenance fund balance")
    expect(html).toContain(formatMoney(30_000))
    expect(html).toContain("TEST Workshop")
    expect(html).toContain("Synthetic brake service")
    const operating = render(view())
    expect(operating).not.toContain("Maintenance fund")
    expect(operating).not.toContain("claims")
  })

  it("asks for a meter reading only on a running lease with contracted usage", () => {
    expect(render(fml)).toContain("Submit reading")
    expect(render(view())).not.toContain("Submit reading")
    const closed = view({ ...fml, loan: { ...fml.loan, status: "COMPLETED" } })
    expect(render(closed)).not.toContain("Submit reading")
  })

  it("offers the early-termination request, and the end-of-term choice only inside its window", () => {
    const early = render(view())
    expect(early).toContain("Request a quote")
    expect(early).toContain("from 30 Jun 2029")
    expect(early).not.toContain("Confirm my choice")
    const near = render(view({ today: "2029-07-01" }))
    expect(near).toContain("Return the asset")
    expect(near).toContain("Extend month to month")
    expect(near).not.toContain("Buy the asset")
  })

  it("hides the early-termination panel once the end of term is chosen", () => {
    const html = render(view({ today: "2029-07-01", endOfTerm: { chosen: { outcome: "RETURN", status: "ELECTED", early: false }, valuation: null } }))
    expect(html).not.toContain("End the lease early")
    expect(html).toContain("You chose to return the asset.")
  })

  it("shows a documents panel only when the page supplies the entity documents", () => {
    expect(render(view())).not.toContain("Statement")
    expect(render(view(), [])).toContain("/api/portal/asset-finance/loans/L1/statement?download=1")
  })

  it("never calls a lease a loan, interest or an instalment", () => {
    const html = render(fml)
    const text = html.replace(/<[^>]+>/g, " ")
    expect(text).not.toMatch(/\b(loan|loans|interest|instalments?)\b/i)
    expect(text).toContain("Rentals")
  })
})
