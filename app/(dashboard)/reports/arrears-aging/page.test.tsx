import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

// The bands and totals come from the helper every screen shares
// (lib/reports/book-arrears.ts); the rows are its "in arrears" population, and
// written-off accounts are a separate section with their own totals.
const { getBookArrears, findMany } = vi.hoisted(() => ({ getBookArrears: vi.fn(), findMany: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loan: { findMany } } }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/reports/charges-owing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reports/charges-owing")>()),
  loadChargesOwingByBand: vi.fn(async () => ({ chargesLive: false, byBand: {}, notInArrears: { count: 0, amount: 0 }, total: 0 })),
}))
vi.mock("@/lib/reports/book-arrears", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reports/book-arrears")>()),
  getBookArrears,
}))

import { overdueWhere } from "@/lib/reports/book-arrears"
import ArrearsAgingPage from "./page"

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
const loan = (reference: string, status: string, dpd: number) => ({
  id: reference, reference, status, daysInArrears: dpd, arrearsAmount: 1_000_00, outstandingPrincipal: 5_000_00,
  chargesOutstanding: 0, collectionsStage: "NONE", nextPaymentDate: null, clientId: "c1",
  client: { firstName: "Synthetic", lastName: reference, idNumber: "9001015000086", phone: "0820000000" },
  entity: null, product: { name: "Micro" },
})

describe("Arrears aging report", () => {
  it("states the shared helper's bands and totals, and lists written-off accounts apart", async () => {
    getBookArrears.mockResolvedValue({
      scope: "ALL", chargesLive: false, book: { count: 10, value: 50_000_00 },
      arrears: { count: 1, amount: 1_000_00, outstandingPrincipal: 5_000_00 }, chargesOnly: { count: 0, amount: 0 },
      ageing: [
        { label: "1-30 DPD", count: 1, arrearsAmount: 1_000_00, outstandingPrincipal: 5_000_00 },
        { label: "31-60 DPD", count: 0, arrearsAmount: 0, outstandingPrincipal: 0 },
        { label: "61-89 DPD", count: 0, arrearsAmount: 0, outstandingPrincipal: 0 },
        { label: "90+ DPD", count: 0, arrearsAmount: 0, outstandingPrincipal: 0 },
      ],
      par30: { count: 0, value: 0, pct: 0 }, par60: { count: 0, value: 0, pct: 0 }, par90: { count: 0, value: 0, pct: 0 },
    })
    findMany.mockImplementation(async (args: { where: { status?: unknown } }) =>
      args.where.status === "WRITTEN_OFF" ? [loan("LN-WO", "WRITTEN_OFF", 200)] : [loan("LN-LIVE", "ACTIVE", 12)])
    const html = text(renderToStaticMarkup(await ArrearsAgingPage()))
    expect(getBookArrears).toHaveBeenCalledWith("tenant-1")
    expect(findMany.mock.calls.map(([args]) => args.where)).toContainEqual(overdueWhere("tenant-1"))
    // Headline totals are the in-arrears book only: R1,000 arrears, not R2,000 with the write-off.
    expect(html).toMatch(/Total Arrears R\s?1[\s,]000\.00/)
    expect(html).toMatch(/Written Off Not in the collectible book or the figures above: 1 account/)
    expect(html.indexOf("LN-LIVE")).toBeLessThan(html.indexOf("Written Off Not in"))
    expect(html.indexOf("LN-WO")).toBeGreaterThan(html.indexOf("Written Off Not in"))
  })
})
