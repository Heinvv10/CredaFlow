import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ open: vi.fn(), loan: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/portal/loan-charges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/loan-charges")>()),
  portalLoanCharges: vi.fn(async () => ({ outstanding: 0, lines: [], settlementAmount: 0 })),
}))
vi.mock("@/lib/asset-finance/surrender-request-gate", () => ({ loadSurrenderRequestOpen: mocks.open }))
vi.mock("@/components/asset-finance/recovery/PortalRecoverySection", () => ({ PortalRecoverySection: () => null }))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findFirst: vi.fn(async () => ({ id: "c1" })) }, loan: { findFirst: mocks.loan } } }))

import PortalLoanPage from "./page"

const loan = (over: Record<string, unknown> = {}) => ({
  id: "l1", clientId: "c1", tenantId: "t1", reference: "LN-1", status: "ACTIVE", daysInArrears: 0, principal: 200_000, totalRepayable: 216_900, totalPaid: 0,
  outstandingPrincipal: 200_000, product: { name: "TLB" }, payments: [], repaymentSchedule: [], contractType: "INSTALMENT_SALE", ncaRegime: "NCA", assetId: "a1",
  surrenderRequests: [], ...over,
})
const render = async () => renderToStaticMarkup(await PortalLoanPage({ params: Promise.resolve({ id: "l1" }) })).replace(/<!-- -->/g, "")

beforeEach(() => {
  vi.clearAllMocks()
  mocks.open.mockResolvedValue(true)
  mocks.loan.mockResolvedValue(loan())
})

describe("portal loan page: the voluntary surrender request", () => {
  it("offers it while the lender does not hold the asset", async () => {
    expect(await render()).toContain("Request voluntary surrender")
    expect(mocks.open).toHaveBeenCalledWith("t1", "l1")
  })

  it("hides it, and the card, once the asset is held (a live recovery or a recovered asset)", async () => {
    mocks.open.mockResolvedValue(false)
    const html = await render()
    expect(html).not.toContain("Request voluntary surrender")
    expect(html).not.toContain("Voluntary surrender")
  })

  it("keeps showing an existing request's status when no new request can be made", async () => {
    mocks.open.mockResolvedValue(false)
    mocks.loan.mockResolvedValue(loan({ surrenderRequests: [{ id: "s1", status: "FINAL_NOTICE_ISSUED" }] }))
    const html = await render()
    expect(html).toContain("Voluntary surrender recorded")
    expect(html).not.toContain("Request voluntary surrender")
  })

  it("does not ask the gate about a non-NCA loan", async () => {
    mocks.loan.mockResolvedValue(loan({ ncaRegime: "NON_NCA" }))
    expect(await render()).not.toContain("Voluntary surrender")
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
