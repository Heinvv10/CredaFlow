import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const { loanFindMany } = vi.hoisted(() => ({ loanFindMany: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("./PrintButton", () => ({ PrintButton: () => null }))
vi.mock("@/lib/prisma", () => ({
  prisma: { client: { findFirst: vi.fn(async () => ({ id: "c1" })) }, loan: { findMany: loanFindMany } },
}))

import StatementPage from "./page"

const loan = (status: string) => ({
  id: `l-${status}`, reference: `LN-${status}`, status, principal: 200_000, outstandingPrincipal: status === "CANCELLED" ? 0 : 169_900,
  totalRepayable: 216_900, totalPaid: 0, daysInArrears: 0, startDate: new Date("2026-10-01"), maturityDate: new Date("2026-11-01"),
  product: { name: "Micro" }, payments: [],
})
const render = async (status: string) => {
  loanFindMany.mockResolvedValue([loan(status)])
  return renderToStaticMarkup(await StatementPage()).replace(/<!-- -->/g, "")
}

describe("portal statements", () => {
  it("offers no payment, payment reference or amount owed on a reversed (CANCELLED) loan", async () => {
    const html = await render("CANCELLED")
    expect(html).not.toContain("/portal/payment")
    expect(html).not.toContain("Payment Reference")
    expect(html).not.toContain("2,169.00")
    expect(html).not.toContain("2 169,00")
  })

  it("keeps them on a loan that is owed", async () => {
    const html = await render("ACTIVE")
    expect(html).toContain("/portal/payment")
    expect(html).toContain("Payment Reference")
  })
})
