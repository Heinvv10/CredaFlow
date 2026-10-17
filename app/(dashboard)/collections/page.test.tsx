import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

// Every Prisma read answers empty: the KPI figures must come from the shared
// book/arrears helper, not from the queue rows.
const empty: Record<string, unknown> = { findMany: [], groupBy: [], count: 0, findUnique: null, aggregate: { _count: 0, _sum: {} } }
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: (_, method: string) => async () => empty[method] }) }),
}))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/collections/section129-artifact", () => ({
  getSection129ReservationAvailability: vi.fn(async () => ({ canReserve: false })),
}))
const band = (count: number, value: number, pct: number) => ({ count, value, pct })
vi.mock("@/lib/reports/book-arrears", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reports/book-arrears")>()),
  getBookArrears: vi.fn(async () => ({
    scope: "ALL",
    chargesLive: false,
    book: { count: 32, value: 262_000_000 },
    arrears: { count: 14, amount: 32_812_345, outstandingPrincipal: 150_000_000 }, chargesOnly: { count: 0, amount: 0 }, ageing: [],
    par30: band(12, 140_000_000, 53.4),
    par60: band(10, 120_000_000, 45.8),
    par90: band(9, 110_000_000, 42.0),
  })),
}))

import CollectionsPage from "./page"
import { BOOK_DEFINITIONS } from "@/lib/reports/book-arrears"

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("Collections KPIs", () => {
  it("states the shared helper's book figures, with their definitions, and says the queue is a subset", async () => {
    const html = text(renderToStaticMarkup(await CollectionsPage()))
    expect(html).toContain("Accounts in Arrears 14")
    expect(html).toContain("Total Arrears R 328,123.45")
    expect(html).toContain("PAR30 53.4%")
    expect(html).toContain(BOOK_DEFINITIONS.arrears)
    expect(html).toContain(BOOK_DEFINITIONS.par)
    expect(html).toContain("14 more accounts in arrears are worked elsewhere")
  })
})
