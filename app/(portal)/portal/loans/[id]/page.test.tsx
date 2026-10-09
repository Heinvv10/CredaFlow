import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi } from "vitest"

const { portalLoanCharges } = vi.hoisted(() => ({ portalLoanCharges: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: vi.fn(async () => "t1") }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/portal/loan-charges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/loan-charges")>()),
  portalLoanCharges,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    loan: {
      findFirst: vi.fn(async () => ({
        id: "l1", clientId: "c1", tenantId: "t1", reference: "LN-1", status: "DEFAULTED", daysInArrears: 25,
        principal: 200_000, totalRepayable: 216_900, totalPaid: 47_000, outstandingPrincipal: 169_900,
        product: { name: "Micro" }, payments: [],
        repaymentSchedule: [{
          id: "r1", installmentNo: 1, dueDate: new Date("2026-09-01"), totalDue: 216_900, totalPaid: 47_000,
          status: "PARTIAL",
        }],
      })),
    },
  },
}))

import PortalLoanPage from "./page"

const render = async () =>
  renderToStaticMarkup(await PortalLoanPage({ params: Promise.resolve({ id: "l1" }) }))
    .replace(/<!-- -->/g, "")

describe("portal loan page", () => {
  it("says what default charges the next payment amount includes", async () => {
    portalLoanCharges.mockResolvedValue({
      outstanding: 3_000, lines: [{ label: "Default interest", amount: 3_000 }], settlementAmount: 172_900,
    })
    const html = await render()
    const card = html.slice(html.indexOf("Next Payment Amount"))
    expect(card.slice(0, card.indexOf("</div>"))).toContain("Includes: Default interest R")
  })

  it("adds no line when no charges are owed", async () => {
    portalLoanCharges.mockResolvedValue({ outstanding: 0, lines: [], settlementAmount: null })
    expect(await render()).not.toContain("Includes:")
  })
})
