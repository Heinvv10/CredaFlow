import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactElement, ReactNode } from "react"

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), session: vi.fn() }))
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found") } }))
vi.mock("@/lib/prisma", () => ({ prisma: { loan: { findUnique: mocks.findUnique } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/payouts/view", () => ({ loadPayoutView: async () => null }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: async () => "t-1" }))
vi.mock("@/lib/auth-session", () => ({ getSession: mocks.session }))
vi.mock("@/lib/loan/loan-page-figures", () => ({
  staffLoanFigures: async () => ({ charges: null, settlementAmount: 0, balance: 0, maturityBalance: 0, arrears: 0, cashPaid: 0, waivable: null, chargesNotDerived: false }),
}))
vi.mock("@/lib/collections/section129-eligibility", () => ({ evaluateCollectionsEligibility: () => ({ eligible: false }) }))
vi.mock("@/lib/collections/section129-artifact", () => ({ getSection129IssuanceAvailability: async () => ({ hasRetrievableIssuedArtifact: false }) }))

import LoanDetailPage from "./page"
import { AssetLoanRecoveryPanels } from "@/components/asset-finance/recovery/AssetLoanRecoveryPanels"

const loan = (over: Record<string, unknown> = {}) => ({
  id: "loan-1", clientId: "c-1", entity: null, contractType: "INSTALMENT_SALE", assetId: "a-1", asset: { id: "a-1" }, status: "ACTIVE", reference: "LN-1",
  client: { id: "c-1", firstName: "Synthetic", lastName: "Client", monthlyIncome: 0 }, product: { name: "TEST" }, repaymentSchedule: [], payments: [],
  principal: 0, daysInArrears: 0, interestRatePm: 0, initiationFee: 0, totalRepayable: 0, startDate: new Date("2026-01-01"), maturityDate: new Date("2027-01-01"),
  applicationId: null, application: null, ...over,
})

function find(node: ReactNode, type: unknown): ReactElement | null {
  if (!node || typeof node !== "object") return null
  if (Array.isArray(node)) return node.map((child) => find(child, type)).find((hit) => hit !== null) ?? null
  const element = node as ReactElement<{ children?: ReactNode }>
  if (element.type === type) return element
  return find(element.props?.children, type)
}
const render = async (over: Record<string, unknown> = {}) => {
  mocks.findUnique.mockResolvedValue(loan(over))
  return LoanDetailPage({ params: Promise.resolve({ id: "loan-1" }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ user: { id: "u-1", role: "LOAN_ADMIN" } })
})

describe("the consumer staff loan page for an asset loan", () => {
  it("shows the legal and recovery panels for a client's instalment sale, with the role's permissions", async () => {
    const panels = find(await render(), AssetLoanRecoveryPanels)
    expect(panels?.props).toMatchObject({ tenantId: "t-1", loanId: "loan-1", userId: "u-1", canManage: true, canDecide: true, canRecordPayment: true })
  })

  it("gives a role without the permissions none of them", async () => {
    mocks.session.mockResolvedValue({ user: { id: "u-2", role: "READONLY" } })
    expect(find(await render(), AssetLoanRecoveryPanels)?.props).toMatchObject({ canManage: false, canDecide: false, canRecordPayment: false })
  })

  it("keeps them off a plain loan", async () => {
    expect(find(await render({ contractType: "LOAN", assetId: null, asset: null }), AssetLoanRecoveryPanels)).toBeNull()
  })
})
