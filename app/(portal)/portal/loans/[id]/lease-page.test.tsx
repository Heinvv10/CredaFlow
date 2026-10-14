import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { formatMoney } from "@/lib/asset-finance/format"
import type { PortalLeaseView } from "@/lib/asset-finance/portal-lease"

const mocks = vi.hoisted(() => ({ loadPortalLease: vi.fn(), redirect: vi.fn(), portalLoanCharges: vi.fn(), loan: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/portal/loan-charges", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/portal/loan-charges")>()), portalLoanCharges: mocks.portalLoanCharges }))
vi.mock("@/lib/asset-finance/portal-lease", () => ({ loadPortalLease: mocks.loadPortalLease }))
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))
vi.mock("@/lib/asset-finance/lease-portal-route", () => ({ clientLeaseRefusal: vi.fn() }))
vi.mock("@/lib/asset-finance/meter-readings", () => ({ recordMeterReading: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { client: { findFirst: vi.fn(async () => ({ id: "c1" })) }, loan: { findFirst: mocks.loan } },
}))

import PortalLoanPage from "./page"

const lease: PortalLeaseView = {
  today: "2027-03-15",
  loan: { id: "L1", reference: "TEST-LS-1", status: "ACTIVE", contractType: "OPERATING_LEASE", startDate: "2027-01-01", maturityDate: "2029-12-31" },
  entity: null, asset: null, rentals: [], arrearsCents: 0, otherCharges: [], defaultCharges: { outstandingCents: 0, lines: [] }, overdueInclChargesCents: 0,
  nextRental: null, fund: null, meter: null,
  termination: { penaltyConfigured: true, latestQuote: null }, endOfTerm: { chosen: null, valuation: null },
}
const row = { id: "L1", clientId: "c1", tenantId: "t1", reference: "TEST-LS-1", contractType: "OPERATING_LEASE", status: "ACTIVE" }

const render = async () => renderToStaticMarkup(await PortalLoanPage({ params: Promise.resolve({ id: "L1" }) })).replace(/<!-- -->/g, "")

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loan.mockResolvedValue(row)
})

describe("portal loan page, for a sole proprietor's lease", () => {
  it("shows the lease view, loaded for this client through the lease gate, not the loan view", async () => {
    mocks.loadPortalLease.mockResolvedValue(lease)
    const html = await render()
    expect(mocks.loadPortalLease).toHaveBeenCalledWith("t1", "c1", "L1")
    expect(html).toContain("Lease TEST-LS-1")
    expect(html).not.toContain("Repayment Schedule")
    expect(html).not.toContain("Monthly Instalment")
  })

  it("shows the lease's charges as the loader read them: overdue including charges, and the other charges", async () => {
    mocks.loadPortalLease.mockResolvedValue({
      ...lease,
      otherCharges: [{ id: "s9", kind: "END_OF_TERM", dueDate: "2027-03-01", totalCents: 50_000, paidCents: 0, outstandingCents: 50_000, state: "OVERDUE", invoice: null }],
      defaultCharges: { outstandingCents: 4_000, lines: [{ label: "Collection fee", amount: 4_000 }] },
      overdueInclChargesCents: 54_000,
    })
    const html = await render()
    expect(html).toContain("Overdue incl. charges")
    expect(html).toContain(formatMoney(54_000))
    expect(html).toContain("End-of-term invoice")
  })

  it("sends a client the lease gate refuses back to the portal", async () => {
    mocks.loadPortalLease.mockResolvedValue(null)
    mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT") })
    await expect(render()).rejects.toThrow("NEXT_REDIRECT")
    expect(mocks.redirect).toHaveBeenCalledWith("/portal")
  })
})
