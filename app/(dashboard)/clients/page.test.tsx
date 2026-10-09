import { describe, it, expect, vi } from "vitest"

const { clientFindMany, clientsProps } = vi.hoisted(() => ({ clientFindMany: vi.fn(), clientsProps: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: vi.fn(async () => "t1") }))
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
})
