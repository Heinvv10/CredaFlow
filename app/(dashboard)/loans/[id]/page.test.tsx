import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  session: vi.fn(),
  consumerPath: vi.fn(async () => { throw new Error("consumer loan page reached") }),
}))
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found") } }))
vi.mock("@/lib/prisma", () => ({ prisma: { loan: { findUnique: mocks.findUnique } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: async () => "t-1" }))
vi.mock("@/lib/auth-session", () => ({ getSession: mocks.session }))
vi.mock("@/lib/loan/loan-page-figures", () => ({ staffLoanFigures: mocks.consumerPath }))
vi.mock("@/components/asset-finance/StaffAssetLoanView", () => ({ StaffAssetLoanView: () => null }))

import LoanDetailPage from "./page"
import { StaffAssetLoanView } from "@/components/asset-finance/StaffAssetLoanView"

const client = { id: "c-1", firstName: "Synthetic", lastName: "Lessee" }
const loan = (over: Record<string, unknown>) => ({ id: "loan-1", clientId: null, client: null, entity: null, contractType: "LOAN", ...over })
const render = (over: Record<string, unknown>) => {
  mocks.findUnique.mockResolvedValue(loan(over))
  return LoanDetailPage({ params: Promise.resolve({ id: "loan-1" }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ user: { id: "u-1", role: "LOAN_ADMIN" } })
})

describe("the staff loan page", () => {
  it("shows an entity borrower's loan in the asset-finance view", async () => {
    const element = await render({ entity: { id: "e-1" }, contractType: "INSTALMENT_SALE" })
    expect(element.type).toBe(StaffAssetLoanView)
  })

  it("shows a sole-proprietor lease, whose lessee is a client, in the asset-finance view with the lease permissions", async () => {
    for (const contractType of ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"]) {
      const element = await render({ clientId: "c-1", client, contractType })
      expect(element.type).toBe(StaffAssetLoanView)
      expect(element.props).toMatchObject({ tenantId: "t-1", userId: "u-1", canManageLease: true, canDecideLease: true })
    }
  })

  it("keeps a consumer loan to a client on the consumer page", async () => {
    await expect(render({ clientId: "c-1", client, contractType: "LOAN" })).rejects.toThrow("consumer loan page reached")
  })

  it("gives a lease no decide permission to a role without it", async () => {
    mocks.session.mockResolvedValue({ user: { id: "u-2", role: "READONLY" } })
    const element = await render({ clientId: "c-1", client, contractType: "OPERATING_LEASE" })
    expect(element.props).toMatchObject({ canManageLease: false, canDecideLease: false })
  })
})
