import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

// InsurancePolicy is a tenant-scope model and pages run outside a tenant
// frame: a policy query without the session tenant throws missing-context.
// The page's later reads are not this test's subject, so the policy query
// stops the render once its arguments are captured.

const mocks = vi.hoisted(() => ({
  policyFindMany: vi.fn(),
  loanFindMany: vi.fn(async () => [] as unknown[]),
  stop: new Error("stop after the policy query"),
}))

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "client@example.test", name: "Test Client" } }) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: async () => "tenant-1" }))
vi.mock("@/lib/portal/loan-charges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/loan-charges")>()),
  portalLoanCharges: async () => ({ outstanding: 0, lines: [], settlementAmount: null }),
}))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: async () => ({ tradingName: "Acme Lending" }) }))
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) } }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: async () => ({ id: "client-1" }) },
    loanApplication: { findFirst: async () => null },
    loan: { findMany: mocks.loanFindMany },
    payment: { findMany: async () => [], groupBy: async () => [] },
    repaymentSchedule: { findFirst: async () => null },
    clientDocument: { findMany: async () => [] },
    insurancePolicy: { findMany: mocks.policyFindMany },
  },
}))

import ClientPortalPage from "./page"

describe("portal overview page", () => {
  beforeEach(() => {
    mocks.policyFindMany.mockReset()
    mocks.policyFindMany.mockRejectedValue(mocks.stop)
  })

  it("reads the client's policies within the session tenant", async () => {
    await expect(ClientPortalPage()).rejects.toBe(mocks.stop)
    expect(mocks.policyFindMany).toHaveBeenCalledOnce()
    expect(mocks.policyFindMany.mock.calls[0][0].where).toEqual({ clientId: "client-1", tenantId: "tenant-1" })
  })

  const loan = (status: string) => ({
    id: `l-${status}`, reference: `LN-${status}`, status, principal: 200_000, outstandingPrincipal: 0, totalRepayable: 216_900,
    totalPaid: 0, daysInArrears: 0, startDate: new Date("2026-10-01"), product: { name: "Micro" },
  })
  const overview = async (statuses: string[]) => {
    mocks.policyFindMany.mockResolvedValue([])
    mocks.loanFindMany.mockResolvedValue(statuses.map(loan))
    return renderToStaticMarkup(await ClientPortalPage())
  }

  it("offers no payment shortcut when the client's only loan was reversed (CANCELLED)", async () => {
    expect(await overview(["CANCELLED"])).not.toContain("/portal/payment")
  })

  it("keeps the payment shortcut while any loan is owed", async () => {
    expect(await overview(["CANCELLED", "ACTIVE"])).toContain("/portal/payment")
  })
})
