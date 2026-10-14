import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { formatMoney } from "@/lib/asset-finance/format"
import { renderedText } from "./lease-test-helpers"
import { LeaseFundPanel } from "./LeaseFundPanel"
import { LeaseReadingsPanel } from "./LeaseReadingsPanel"
import { LeaseRentalsTable } from "./LeaseRentalsTable"
import { LeaseTerminationPanel } from "./LeaseTerminationPanel"
import type { ClaimRow, FundView, LeaseStaffData, QuoteRow, RentalRow } from "./lease-staff-data"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })

async function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(element) })
  return renderer
}
const text = renderedText
const buttons = (r: ReactTestRenderer) => r.root.findAllByType("button").map((b) => b.children.join(""))

const rental = (periodNo: number, over: Partial<RentalRow> = {}): RentalRow => ({
  periodNo, dueDate: `2030-0${periodNo}-01`, rentalExclVatCents: 100_000, maintenanceExclVatCents: 10_000, vatCents: 16_500, totalCents: 126_500,
  cancelled: false, scheduleStatus: "PENDING", invoice: null, ...over,
})
const claim = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  id: "c-1", status: "SUBMITTED", amountExclVatCents: 450_000, description: "New hydraulic hose", supplier: "TEST Supplier", invoiceFile: "invoice.pdf",
  submittedOn: "2030-05-02", submittedById: "u-submitter", firstApprovedById: null, rejectionReason: null, paymentReference: null, ...over,
})
const fund = (claims: ClaimRow[]): FundView => ({
  riskModel: "LENDER_RISK", leaseEndDate: "2030-12-01", settledAt: null, balanceCents: -50_000, contributedCents: 400_000, claimedCents: 450_000, claims,
  movements: [{ id: "m-1", kind: "CONTRIBUTION", amountCents: 10_000, occurredOn: "2030-02-01", periodNo: 1 }, { id: "m-2", kind: "CLAIM", amountCents: 450_000, occurredOn: "2030-05-09", periodNo: null }],
  dualApprovalCents: 5_000_000,
})
const fundPanel = (f: FundView, over: { userId?: string; canManage?: boolean; canDecide?: boolean } = {}) =>
  render(<LeaseFundPanel loanId="loan-1" loanStatus="ACTIVE" today="2030-06-15" fund={f} userId={over.userId ?? "u-decider"} canManage={over.canManage ?? true}
    canDecide={over.canDecide ?? true} options={{ suppliers: [{ id: "s-1", label: "TEST Supplier" }], documents: [{ id: "d-1", label: "invoice.pdf" }], readings: [] }} />)

describe("LeaseRentalsTable", () => {
  it("links the tax invoice of an invoiced rental and says so for one not yet invoiced", async () => {
    const r = await render(<LeaseRentalsTable today="2030-06-15" maintenance rentals={[
      rental(1, { scheduleStatus: "PAID", invoice: { id: "inv-1", number: "INV-000001" } }), rental(2), rental(3, { cancelled: true }),
    ]} />)
    const links = r.root.findAllByType("a").map((a) => a.props.href)
    expect(links).toEqual(["/api/asset-finance/tax-invoices/inv-1", "/api/asset-finance/tax-invoices/inv-1?download=1"])
    expect(text(r)).toContain("INV-000001")
    expect(text(r)).toContain("Not yet invoiced")
    expect(text(r)).toContain("Cancelled")
    expect(text(r)).toContain("Maintenance ex VAT")
  })

  it("leaves the maintenance column out of an operating lease", async () => {
    const r = await render(<LeaseRentalsTable today="2030-06-15" maintenance={false} rentals={[rental(1)]} />)
    expect(text(r)).not.toContain("Maintenance ex VAT")
  })
})

describe("LeaseFundPanel", () => {
  it("shows the balance and movements and lets another decider approve or reject a submitted claim", async () => {
    const r = await fundPanel(fund([claim()]))
    expect(text(r)).toContain(formatMoney(-50_000))
    expect(text(r)).toContain("Rental contribution (rental 1)")
    expect(text(r)).toContain("Claim paid")
    expect(buttons(r)).toEqual(expect.arrayContaining(["Approve", "Reject", "Submit claim"]))
  })

  it("withholds Approve from the claim's own submitter and says why", async () => {
    const r = await fundPanel(fund([claim()]), { userId: "u-submitter" })
    expect(buttons(r)).not.toContain("Approve")
    expect(text(r)).toContain("You submitted this claim")
  })

  it("marks an approved claim paid and hides the claim form for a user who cannot manage", async () => {
    const r = await fundPanel(fund([claim({ status: "APPROVED" })]), { canManage: false })
    expect(buttons(r)).toEqual(["Mark paid"])
  })

  it("hides every decision from a user without the decide permission", async () => {
    const r = await fundPanel(fund([claim()]), { canDecide: false, canManage: false })
    expect(buttons(r)).toEqual([])
  })
})

describe("LeaseTerminationPanel", () => {
  const quote = (over: Partial<QuoteRow> = {}): QuoteRow => ({
    id: "q-1", status: "QUOTED", quotedOn: "2030-06-10", terminationDate: "2030-06-10", validUntil: "2030-06-20", cpaCancellation: false, remainingRentals: 8,
    pvCents: 800_000, penaltyCents: 80_000, arrearsCents: 0, invoiceVatCents: 132_000, totalCents: 1_012_000, basis: "Present value of the rentals", invoice: null, ...over,
  })
  const data = (quotes: QuoteRow[], over: Partial<LeaseStaffData> = {}) => ({
    loanId: "loan-1", loanStatus: "ACTIVE", today: "2030-06-15", endOfTerm: null, quotes, deal: { earlyTerminationPenaltyRate: "0.10" }, ...over,
  }) as LeaseStaffData

  it("offers a new quote and accepting a live one", async () => {
    const r = await render(<LeaseTerminationPanel data={data([quote()])} canManage canDecide />)
    expect(buttons(r)).toEqual(["Request a quote", "Accept on the lessee's instruction"])
    expect(text(r)).toContain(formatMoney(1_012_000))
  })

  it("offers no accept on an expired or accepted quote, and no quote once an end of term exists", async () => {
    const expired = await render(<LeaseTerminationPanel data={data([quote({ validUntil: "2030-06-14" })])} canManage canDecide />)
    expect(buttons(expired)).toEqual(["Request a quote"])
    const accepted = await render(<LeaseTerminationPanel data={data([quote({ status: "ACCEPTED", invoice: { id: "inv-9", number: "INV-000009" } })])} canManage canDecide />)
    expect(buttons(accepted)).toEqual(["Request a quote"])
    expect(text(accepted)).toContain("INV-000009")
    const closing = await render(<LeaseTerminationPanel data={data([quote()], { endOfTerm: {} as LeaseStaffData["endOfTerm"] })} canManage canDecide />)
    expect(buttons(closing)).toEqual([])
  })
})

describe("LeaseReadingsPanel", () => {
  const view = {
    loanId: "loan-1", today: "2030-06-15", readings: [{ id: "r-2", readingDate: "2030-06-01", value: 1500, source: "PORTAL" }, { id: "r-1", readingDate: "2030-01-01", value: 1000, source: "STAFF" }],
    usage: { usedUnits: 500, projectedFinalReading: 2200, excessCents: 30_000, allowedUnits: 1000 },
  } as LeaseStaffData
  const usage = { unit: "HOURS", allowancePerYear: 1200, excessRateCents: 4_500 } as const

  it("shows the usage so far, the projection and the readings, with the form for a manager", async () => {
    const r = await render(<LeaseReadingsPanel data={view} usage={usage} canRecord />)
    expect(text(r)).toContain("500 hours")
    expect(text(r)).toContain(formatMoney(30_000))
    expect(text(r)).toContain("Lessee (portal)")
    expect(buttons(r)).toEqual(["Record reading"])
    expect(buttons(await render(<LeaseReadingsPanel data={view} usage={usage} canRecord={false} />))).toEqual([])
  })
})
