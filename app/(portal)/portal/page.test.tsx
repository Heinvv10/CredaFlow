import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

// InsurancePolicy is a tenant-scope model and pages run outside a tenant
// frame: a policy query without the session tenant throws missing-context.
// The page's later reads are not this test's subject, so the policy query
// stops the render once its arguments are captured.

const mocks = vi.hoisted(() => ({
  nextSchedule: vi.fn(async () => null as unknown),
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
    repaymentSchedule: { findFirst: mocks.nextSchedule },
    clientDocument: { findMany: async () => [] },
    insurancePolicy: { findMany: mocks.policyFindMany },
  },
}))

import ClientPortalPage from "./page"

describe("portal overview page", () => {
  beforeEach(() => {
    mocks.nextSchedule.mockResolvedValue(null)
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

  // Elize, Fair Score audit 2026-10-16: the banner said "27 days overdue" (the
  // cron's stamp) with no amount; due 17 Sep, seen 16 Oct is 29 days, R843.30.
  it("shows the overdue amount and the days overdue as of today", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T10:00:00Z"), toFake: ["Date"] })
    try {
      mocks.policyFindMany.mockResolvedValue([])
      mocks.loanFindMany.mockResolvedValue([{
        ...loan("ACTIVE"), principal: 3_400_000, outstandingPrincipal: 2_713_391, daysInArrears: 27,
        repaymentSchedule: [
          { dueDate: new Date("2026-09-17T06:30:01Z"), principalDue: 289_000, interestDue: 50_000, feesDue: 0, totalDue: 339_000, totalPaid: 254_670 },
          { dueDate: new Date("2026-10-17T06:30:01Z"), principalDue: 289_000, interestDue: 50_000, feesDue: 0, totalDue: 339_000, totalPaid: 0 },
        ],
      }])
      const html = renderToStaticMarkup(await ClientPortalPage()).replace(/<!-- -->/g, "")
      expect(html).toContain("your account is 29 days overdue")
      expect(html).toMatch(/Pay R\s?843[.,]30 to bring your account up to date/)
    } finally {
      vi.useRealTimers()
    }
  })
  it("does not describe the next scheduled payment as all account principal", async () => {
    mocks.policyFindMany.mockResolvedValue([])
    mocks.loanFindMany.mockResolvedValue([loan("ACTIVE")])
    mocks.nextSchedule.mockResolvedValue({ dueDate: new Date("2027-01-01"), totalDue: 100_000 })
    const html = renderToStaticMarkup(await ClientPortalPage())
    const nextPayment = html.slice(html.indexOf("Your Next Payment"), html.indexOf("</section>", html.indexOf("Your Next Payment")))
    expect(nextPayment).toContain("1,000.00")
    expect(nextPayment).not.toContain("Principal still owed across your open loans")
    expect(nextPayment).not.toContain("across your open loans. Open each loan")
  })

})
