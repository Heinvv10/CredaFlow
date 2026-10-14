import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PortalContractView } from "@/lib/asset-finance/portal-contract"
import type { PortalLeaseView } from "@/lib/asset-finance/portal-lease"

const mocks = vi.hoisted(() => ({ loadPortalLease: vi.fn(), loadPortalContract: vi.fn(), notFound: vi.fn() }))
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/asset-finance/portal-page", () => ({ requirePortalEntityPage: vi.fn(async () => ({ tenantId: "t1", clientId: "c1" })) }))
vi.mock("@/lib/asset-finance/portal-contract", () => ({ loadPortalContract: mocks.loadPortalContract }))
vi.mock("@/lib/asset-finance/portal-lease", () => ({ loadPortalLease: mocks.loadPortalLease }))
vi.mock("@/lib/asset-finance/signing", () => ({ DEAL_DOCUMENT_LABELS: { AGREEMENT: "Asset finance agreement" }, SIGNER_STATE_LABELS: { SIGNED: "Signed" } }))
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))
vi.mock("@/lib/asset-finance/lease-portal-route", () => ({ clientLeaseRefusal: vi.fn() }))
vi.mock("@/lib/asset-finance/meter-readings", () => ({ recordMeterReading: vi.fn() }))

import PortalContractPage from "./page"

const contract = (contractType: string) => ({
  loan: { id: "L1", reference: "TEST-1", status: "ACTIVE", contractType, ncaRegime: "NON_NCA" },
  entity: { id: "e1", legalName: "TEST Lessee (Pty) Ltd" }, asset: null, rate: null,
  startDate: "2027-01-01T00:00:00.000Z", maturityDate: "2029-12-31T00:00:00.000Z", balloonCents: 0, outstandingCents: 0, chargesLive: false, chargeLines: [],
  arrears: { amountCents: 0, days: 0 }, nextPayment: null, schedule: [], taxInvoice: null, surrender: null,
  documents: [{ signerId: "s1", document: "AGREEMENT", signerName: "TEST Signer", state: "SIGNED", scanDocumentId: null }],
}) as unknown as PortalContractView

const lease: PortalLeaseView = {
  today: "2027-03-15",
  loan: { id: "L1", reference: "TEST-1", status: "ACTIVE", contractType: "FULL_MAINTENANCE_LEASE", startDate: "2027-01-01", maturityDate: "2029-12-31" },
  entity: { id: "e1", legalName: "TEST Lessee (Pty) Ltd" }, asset: null, rentals: [], arrearsCents: 0, otherCharges: [], defaultCharges: { outstandingCents: 0, lines: [] }, overdueInclChargesCents: 0,
  nextRental: null, fund: null, meter: null,
  termination: { penaltyConfigured: true, latestQuote: null }, endOfTerm: { chosen: null, valuation: null },
}

const render = async () => renderToStaticMarkup(await PortalContractPage({ params: Promise.resolve({ entityId: "e1", loanId: "L1" }) })).replace(/<!-- -->/g, "")

beforeEach(() => {
  vi.clearAllMocks()
  mocks.notFound.mockImplementation(() => { throw new Error("NEXT_NOT_FOUND") })
})

describe("portal entity contract page", () => {
  it("shows a lease as rentals, behind the lease gate, with the entity's signed documents", async () => {
    mocks.loadPortalContract.mockResolvedValue(contract("FULL_MAINTENANCE_LEASE"))
    mocks.loadPortalLease.mockResolvedValue(lease)
    const html = await render()
    expect(mocks.loadPortalLease).toHaveBeenCalledWith("t1", "c1", "L1")
    expect(html).toContain("Lease TEST-1")
    expect(html).toContain("Back to TEST Lessee (Pty) Ltd")
    expect(html).toContain("Asset finance agreement")
    expect(html).not.toContain("Repayment schedule")
  })

  it("is a 404 when the lease gate refuses", async () => {
    mocks.loadPortalContract.mockResolvedValue(contract("FULL_MAINTENANCE_LEASE"))
    mocks.loadPortalLease.mockResolvedValue(null)
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("leaves a hire-purchase contract on its own view", async () => {
    mocks.loadPortalContract.mockResolvedValue(contract("HIRE_PURCHASE"))
    const html = await render()
    expect(mocks.loadPortalLease).not.toHaveBeenCalled()
    expect(html).toContain("Contract TEST-1")
    expect(html).toContain("Repayment schedule")
  })
})
