import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  clientProps: vi.fn(),
  appFindFirst: vi.fn(),
  loanFindMany: vi.fn(),
  approvedFindMany: vi.fn(),
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
    loanApplication: { findFirst: (a: unknown) => h.appFindFirst(a), findMany: (a: unknown) => h.approvedFindMany(a) },
    // The real own-lender loader runs over these (lib/affordability/own-lender-debt-load.ts).
    loan: { findMany: (a: unknown) => h.loanFindMany(a) },
    tenant: { findUnique: vi.fn(async () => ({ name: "Acme Credit" })) },
    tenantConfig: { findUnique: vi.fn(async () => ({ brandName: "Acme Credit", legalName: "Acme Credit (Pty) Ltd" })) },
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
  client: { existingDebt: number }
  ownLenderArrears: { days: number; amountCents: number } | null
  qualification: { ndi: number; microLoan: { maxAmount: number } }
  bounds: { micro: { maxAmount: number } }
  recentDecline: { id: string; reference: string; decidedOn: string } | null
}
const props = () => h.clientProps.mock.calls.at(-1)![0] as Props

describe("portal apply page", () => {
  beforeEach(() => { h.clientProps.mockReset(); h.appFindFirst.mockReset().mockResolvedValue(null); h.loanFindMany.mockReset().mockResolvedValue([]); h.approvedFindMany.mockReset().mockResolvedValue([]) })

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

  it("counts the client's own active loan with this lender, and says they are in arrears", async () => {
    // Synthetic: R1,029.17 a month, 60 days and R2,058.34 behind.
    h.loanFindMany.mockResolvedValue([{
      id: "loan-1", clientId: "c1", reference: "LN-SYN-1", status: "ACTIVE", outstandingPrincipal: 500_000,
      daysInArrears: 60, arrearsAmount: 205_834,
      repaymentSchedule: [{ totalDue: 120_000 }, { totalDue: 102_917 }, { totalDue: 102_917 }],
    }])
    await renderPage()
    expect(props().client.existingDebt).toBe(87_000 + 102_917)
    expect(props().qualification.ndi).toBe(1_800_000 - 800_000 - 87_000 - 102_917)
    expect(props().ownLenderArrears).toEqual({ days: 60, amountCents: 205_834 })
    expect(h.loanFindMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", clientId: "c1" })
  })

  it("changes nothing for a client with no loan with this lender", async () => {
    await renderPage()
    expect(props().client.existingDebt).toBe(87_000)
    expect(props().ownLenderArrears).toBeNull()
  })

  it("still renders, on declared debt, when an approved application has no recorded instalment", async () => {
    // The loader refuses it (it cannot be counted); an estimate must not 500.
    h.approvedFindMany.mockResolvedValue([{ id: "a1", reference: "APP-SYN-1", approvedAmount: 500_000, affordabilityResult: null }])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await renderPage()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("APP-SYN-1"))
    } finally {
      warn.mockRestore()
    }
    expect(props().client.existingDebt).toBe(87_000)
    expect(props().ownLenderArrears).toBeNull()
  })

  it("does not swallow other loader errors", async () => {
    h.loanFindMany.mockRejectedValue(new Error("db down"))
    await expect(renderPage()).rejects.toThrow("db down")
  })
})
