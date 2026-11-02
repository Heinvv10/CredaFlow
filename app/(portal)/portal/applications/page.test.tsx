import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { client: { findFirst: vi.fn(async () => ({ id: "c1" })) }, loanApplication: { findMany: h.findMany } },
}))

import ApplicationsPage from "./page"

describe("portal applications list", () => {
  it("does not list a loan change's application until it is disbursed: the borrower did not apply for it", async () => {
    const row = { status: "UNDER_REVIEW", appliedAmount: 3_000_000, createdAt: new Date("2026-04-10T08:00:00Z"), agreementGeneratedAt: null, agreementSignedAt: null, decisionReason: null, product: { name: "Personal Loan" }, loan: null }
    const rows = [
      { ...row, id: "a1", reference: "APP-OWN", loanChangeRequestId: null },
      { ...row, id: "a2", reference: "APP-CHANGE-OPEN", loanChangeRequestId: "cr1" },
      { ...row, id: "a3", reference: "APP-CHANGE-PAID", loanChangeRequestId: "cr2", status: "DISBURSED", loan: { status: "ACTIVE" } },
    ]
    h.findMany.mockImplementation(async ({ where }: { where: { OR?: Array<Record<string, unknown>> } }) =>
      rows.filter((r) => !where.OR || where.OR.some((clause) => Object.entries(clause).every(([key, value]) => r[key as keyof typeof r] === value))))
    const html = renderToStaticMarkup(await ApplicationsPage())
    expect(html).toContain("APP-OWN")
    expect(html).toContain("APP-CHANGE-PAID")
    expect(html).not.toContain("APP-CHANGE-OPEN")
  })

  it("shows a paid-up loan's application as Settled and never loads the staff-only note", async () => {
    h.findMany.mockResolvedValue([{
      id: "a1", reference: "APP-1", status: "DISBURSED", appliedAmount: 3_000_000, createdAt: new Date("2026-04-10T08:00:00Z"),
      agreementGeneratedAt: null, agreementSignedAt: null, decisionReason: null,
      product: { name: "Personal Loan" }, loan: { status: "COMPLETED" },
    }])
    const html = renderToStaticMarkup(await ApplicationsPage())
    expect(html).toContain(">Settled<")
    const args = h.findMany.mock.calls[0][0] as { select?: Record<string, unknown>; include?: unknown }
    expect(args.include).toBeUndefined()
    expect(args.select).not.toHaveProperty("declineInternalNote")
  })
})
