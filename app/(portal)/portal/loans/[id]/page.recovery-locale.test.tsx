import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PortalLeaseView } from "@/lib/asset-finance/portal-lease"

const mocks = vi.hoisted(() => ({ loan: vi.fn(), loadPortalLease: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("@/lib/i18n/server", () => ({ getLocale: vi.fn(async () => "af") }))
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/portal/loan-charges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/loan-charges")>()),
  portalLoanCharges: vi.fn(async () => ({ outstanding: 0, lines: [], settlementAmount: 0 })),
}))
vi.mock("@/lib/asset-finance/surrender-request-gate", () => ({ loadSurrenderRequestOpen: vi.fn(async () => false) }))
vi.mock("@/lib/asset-finance/portal-lease", () => ({ loadPortalLease: mocks.loadPortalLease }))
// The recovery card is an async server component (it reads the DB): stubbed here, and asserted by its props.
vi.mock("@/components/asset-finance/recovery/PortalRecoverySection", () => ({
  PortalRecoverySection: ({ loanId, locale }: { loanId: string; locale: string }) => `recovery-section:${loanId}:${locale}`,
}))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findFirst: vi.fn(async () => ({ id: "c1" })) }, loan: { findFirst: mocks.loan } } }))

import PortalLoanPage from "./page"

const base = {
  id: "l1", clientId: "c1", tenantId: "t1", reference: "LN-1", status: "ACTIVE", daysInArrears: 0, principal: 200_000, totalRepayable: 216_900, totalPaid: 0,
  outstandingPrincipal: 200_000, product: { name: "TLB" }, payments: [], repaymentSchedule: [], ncaRegime: "NCA", assetId: "a1", surrenderRequests: [],
}
const lease = {
  today: "2027-03-15",
  loan: { id: "l1", reference: "TEST-LS-1", status: "ACTIVE", contractType: "OPERATING_LEASE", startDate: "2027-01-01", maturityDate: "2029-12-31" },
  entity: null, asset: null, rentals: [], arrearsCents: 0, otherCharges: [], defaultCharges: { outstandingCents: 0, lines: [] }, overdueInclChargesCents: 0,
  nextRental: null, fund: null, meter: null,
  termination: { penaltyConfigured: true, latestQuote: null }, endOfTerm: { chosen: null, valuation: null, expiryNotice: false },
} as unknown as PortalLeaseView
const render = async () => renderToStaticMarkup(await PortalLoanPage({ params: Promise.resolve({ id: "l1" }) })).replace(/<!-- -->/g, "")

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadPortalLease.mockResolvedValue(lease)
})

describe("portal contract page: the recovery card's language", () => {
  it("is the borrower's language on an instalment-sale page", async () => {
    mocks.loan.mockResolvedValue({ ...base, contractType: "INSTALMENT_SALE" })
    expect(await render()).toContain("recovery-section:l1:af")
  })

  it("stays English on a lease page, which is not translated", async () => {
    mocks.loan.mockResolvedValue({ ...base, contractType: "OPERATING_LEASE" })
    expect(await render()).toContain("recovery-section:l1:en")
  })
})
