import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  clientProps: vi.fn(),
  appFindFirst: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "lerato@example.test" } })) }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("@/lib/i18n/server", () => ({ getLocale: vi.fn(async () => "en") }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: {
      findFirst: vi.fn(async () => ({
        id: "c1", firstName: "Lerato", monthlyIncome: 1_800_000, monthlyExpenses: 800_000,
        debtObligations: [{ monthlyInstalment: 87_000 }],
      })),
    },
    loanApplication: { findFirst: (a: unknown) => h.appFindFirst(a) },
  },
}))
vi.mock("@/lib/public-loan-products-server", async () => {
  const { publicLoanProducts } = await import("@/lib/public-loan-products")
  // The tenant's live 30-Day Micro Loan lends at most R2,000.
  return {
    getLivePublicProductsServer: async () =>
      publicLoanProducts.map((p) => (p.code === "short-term" ? { ...p, maxAmount: 200_000 } : p)),
  }
})
vi.mock("./PortalApplyClient", () => ({ PortalApplyClient: (props: unknown) => { h.clientProps(props); return null } }))

import { renderToStaticMarkup } from "react-dom/server"
import PortalApplyPage from "./page"

const renderPage = async () => renderToStaticMarkup(await PortalApplyPage())

type Props = {
  qualification: { microLoan: { maxAmount: number } }
  bounds: { micro: { maxAmount: number } }
  recentDecline: { id: string; reference: string; decidedOn: string } | null
}
const props = () => h.clientProps.mock.calls.at(-1)![0] as Props

describe("portal apply page", () => {
  beforeEach(() => { h.clientProps.mockReset(); h.appFindFirst.mockReset().mockResolvedValue(null) })

  it("bounds the micro-loan offer by the live product maximum", async () => {
    await renderPage()
    expect(props().bounds.micro.maxAmount).toBe(200_000)
    expect(props().qualification.microLoan.maxAmount).toBe(200_000)
  })

  it("looks for a decline in the last 30 days and passes it on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"))
    h.appFindFirst.mockResolvedValue({
      id: "app-9", reference: "APP-1", approvedAt: new Date("2026-10-16T11:00:00.000Z"), updatedAt: new Date("2026-10-16T11:00:00.000Z"),
    })
    try {
      await renderPage()
    } finally {
      vi.useRealTimers()
    }
    const where = h.appFindFirst.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: "t1", clientId: "c1", status: "DECLINED" })
    expect(where.OR[0].approvedAt.gte).toEqual(new Date("2026-09-16T12:00:00.000Z"))
    expect(props().recentDecline).toEqual({ id: "app-9", reference: "APP-1", decidedOn: expect.stringContaining("2026") })
  })

  it("passes no decline when there is none", async () => {
    await renderPage()
    expect(props().recentDecline).toBeNull()
  })
})
