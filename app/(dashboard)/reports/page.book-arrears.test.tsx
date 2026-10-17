import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

// Every Prisma read answers empty: ageing, arrears rate, NPL and PAR must come
// from the helper every screen shares (lib/reports/book-arrears.ts).
const empty: Record<string, unknown> = { aggregate: { _count: 0, _sum: {} }, findMany: [], groupBy: [], count: 0 }
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: (_, method: string) => async () => empty[method] }) }),
}))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: vi.fn(async () => ({ id: "u1" })) }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/reports/charges-owing", () => ({
  loadChargesOwingByBand: vi.fn(async () => ({ chargesLive: false, byBand: {}, notInArrears: { count: 0, amount: 0 }, total: 0 })),
}))
vi.mock("@/lib/reports/book-as-of", () => ({ loadBookAsOf: vi.fn(async () => 0) }))
const band = (count: number, value: number, pct: number) => ({ count, value, pct })
const { getBookArrears } = vi.hoisted(() => ({ getBookArrears: vi.fn() }))
vi.mock("@/lib/reports/book-arrears", () => ({ getBookArrears }))

import ReportsPage from "./page"

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("Reports overview book figures", () => {
  it("states the shared helper's ageing, arrears rate, NPL and PAR", async () => {
    getBookArrears.mockResolvedValue({
      scope: "ALL", chargesLive: false,
      book: { count: 40, value: 1_000_000_00 },
      arrears: { count: 7, amount: 9_000_00, outstandingPrincipal: 250_000_00 },
      chargesOnly: { count: 0, amount: 0 },
      ageing: [
        { label: "1-30 DPD", count: 3, arrearsAmount: 1_000_00, outstandingPrincipal: 80_000_00 },
        { label: "31-60 DPD", count: 2, arrearsAmount: 2_000_00, outstandingPrincipal: 70_000_00 },
        { label: "61-89 DPD", count: 1, arrearsAmount: 3_000_00, outstandingPrincipal: 50_000_00 },
        { label: "90+ DPD", count: 1, arrearsAmount: 3_000_00, outstandingPrincipal: 50_000_00 },
      ],
      par30: band(4, 170_000_00, 17), par60: band(2, 100_000_00, 10), par90: band(1, 50_000_00, 5),
    })
    const html = text(renderToStaticMarkup(await ReportsPage()))
    expect(getBookArrears).toHaveBeenCalledWith("tenant-1")
    expect(html).toContain("25.0%") // arrears rate: R250,000 of R1,000,000
    expect(html).toContain("5.0%") // NPL = PAR90
    expect(html).toMatch(/61-89 DPD[^%]*1/)
  })
})
