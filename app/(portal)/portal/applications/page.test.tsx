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
