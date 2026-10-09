import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi } from "vitest"
import { formatZAR } from "@/lib/utils"

const { loanFindMany } = vi.hoisted(() => ({ loanFindMany: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: vi.fn(async () => "t1") }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    loan: { findMany: loanFindMany },
  },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))

import PortalLoansPage from "./page"

describe("portal loans list", () => {
  it("shows Total Paid as the cash the borrower paid, not the share applied to the instalments", async () => {
    loanFindMany.mockResolvedValue([{
      id: "l1", reference: "LN-1", status: "DEFAULTED", startDate: new Date("2026-08-01"),
      outstandingPrincipal: 166_900, totalPaid: 42_000, totalRepayable: 216_900, nextPaymentDate: null,
      product: { name: "Micro" },
      payments: [
        { amount: 50_000, paymentMethod: "EFT", reversed: false, allocationStatus: "ALLOCATED" },
        { amount: 90, paymentMethod: "WAIVER", reversed: false, allocationStatus: "ALLOCATED" },
        { amount: 20_000, paymentMethod: "EFT", reversed: true, allocationStatus: "ALLOCATED" },
      ],
    }])
    const html = renderToStaticMarkup(await PortalLoansPage())
    expect(html).toContain(formatZAR(50_000))
    expect(html).not.toContain(formatZAR(42_000))
  })
})
