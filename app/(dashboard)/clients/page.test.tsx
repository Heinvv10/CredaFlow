import { describe, it, expect, vi } from "vitest"

const { clientFindMany, clientsProps } = vi.hoisted(() => ({ clientFindMany: vi.fn(), clientsProps: vi.fn() }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "t1") }))
const session = vi.hoisted(() => ({ role: "CREDIT_OFFICER" }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u1", role: session.role } })) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findMany: clientFindMany },
    conversation: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock("@/components/clients/ClientsPageClient", () => ({
  ClientsPageClient: (props: unknown) => { clientsProps(props); return null },
}))

import ClientsPage from "./page"
import { renderToStaticMarkup } from "react-dom/server"

describe("clients list", () => {
  it("gives each loan the cash its borrower paid, for the Total repaid figure", async () => {
    clientFindMany.mockResolvedValue([{
      id: "c1", _count: { loans: 1, applications: 1 },
      loans: [{
        daysInArrears: 25, totalPaid: 42_000,
        payments: [
          { amount: 50_000, paymentMethod: "EFT", reversed: false, allocationStatus: "ALLOCATED" },
          { amount: 90, paymentMethod: "WAIVER", reversed: false, allocationStatus: "ALLOCATED" },
        ],
      }],
    }])
    renderToStaticMarkup(await ClientsPage())
    const { clients } = clientsProps.mock.calls[0][0] as { clients: Array<{ loans: Array<{ cashPaid: number }> }> }
    expect(clients[0].loans).toEqual([{ daysInArrears: 25, cashPaid: 50_000 }])
  })

  // Security review of #145: the list is open to INSURANCE_OFFICER, but its
  // loan counts, arrears, repayments and income were sent with it.
  it("sends a role without the loan book no loan, application or income figure", async () => {
    session.role = "INSURANCE_OFFICER"
    clientsProps.mockClear()
    clientFindMany.mockResolvedValue([{
      id: "c1", monthlyIncome: 1_500_000, _count: { loans: 2, applications: 3 },
      loans: [{ daysInArrears: 25, payments: [{ amount: 50_000, paymentMethod: "EFT", reversed: false, allocationStatus: "ALLOCATED" }] }],
    }])
    try {
      renderToStaticMarkup(await ClientsPage())
      const props = clientsProps.mock.calls[0][0] as { loanBook: boolean; clients: Array<Record<string, unknown>> }
      expect(props.loanBook).toBe(false)
      expect(props.clients[0]).toEqual({ id: "c1", unreadCount: 0 })
    } finally {
      session.role = "CREDIT_OFFICER"
    }
  })
})
