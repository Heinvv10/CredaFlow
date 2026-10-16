import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

// Every Prisma read answers empty: book, arrears and PAR must come from the
// shared helper, all scope for the operational panels, NCA for the NCR panel.
const empty: Record<string, unknown> = { findMany: [], groupBy: [], count: 0, findUnique: null, aggregate: { _count: 0, _sum: {} } }
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: (_, method: string) => async () => empty[method] }) }),
}))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { name: "Test Staff" } })) }))
const band = (count: number, value: number, pct: number) => ({ count, value, pct })
const figures = {
  ALL: {
    book: { count: 32, value: 262_000_000 },
    arrears: { count: 15, amount: 32_800_000, outstandingPrincipal: 150_000_000 },
    par30: band(13, 140_000_000, 53.4), par60: band(11, 120_000_000, 45.8), par90: band(9, 110_000_000, 42.0),
  },
  NCA: {
    book: { count: 25, value: 115_271_450 },
    arrears: { count: 12, amount: 14_959_766, outstandingPrincipal: 97_000_000 },
    par30: band(11, 97_000_000, 84.2), par60: band(10, 90_000_000, 78.1), par90: band(8, 80_000_000, 69.4),
  },
}
vi.mock("@/lib/reports/book-arrears", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reports/book-arrears")>()),
  getBookArrears: vi.fn(async (_tenantId: string, scope: "ALL" | "NCA") => ({ scope, chargesLive: false, ...figures[scope] })),
}))

import DashboardPage from "./page"
import { BOOK_DEFINITIONS } from "@/lib/reports/book-arrears"

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("Executive dashboard book figures", () => {
  it("shows the helper's all-agreements figures with their definitions", async () => {
    const html = text(renderToStaticMarkup(await DashboardPage()))
    expect(html).toContain("Book value R 2.62m 32 loans owed")
    expect(html).toContain("Total arrears R 328k 15 accounts")
    expect(html).toContain("15 accounts in arrears.")
    expect(html).toContain("PAR 30+ 53.4% 13")
    expect(html).toContain(BOOK_DEFINITIONS.scopeAll)
    expect(html).toContain(BOOK_DEFINITIONS.par)
  })

  it("states the NCR return's own NCA figures in the NCR panel", async () => {
    const html = text(renderToStaticMarkup(await DashboardPage()))
    expect(html).toContain("Collectible book (NCA) R 1.15m")
    expect(html).toContain("PAR 30+ 84.2% · 11 accounts")
    expect(html).toContain("NPL (PAR 90+) 69.4% · 8 accounts")
    expect(html).toContain(BOOK_DEFINITIONS.scopeNca)
  })
})
