import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DefaultChargesReport } from "@/lib/reports/default-charges-loader"

const { loaders } = vi.hoisted(() => ({
  loaders: { report: vi.fn(), inDuplum: vi.fn() },
}))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: vi.fn(async () => ({ id: "u1" })) }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/reports/default-charges-loader", () => ({
  loadDefaultChargesReport: (...a: unknown[]) => loaders.report(...a),
  loadInDuplumSnapshot: (...a: unknown[]) => loaders.inDuplum(...a),
}))

import DefaultChargesReportPage from "./page"

const now = new Date()
const report = (over: Partial<DefaultChargesReport>): DefaultChargesReport => ({
  state: "live", startedAt: new Date("2026-09-01T08:00:00Z"), stoppedAt: null, rows: [], months: [],
  refundsDue: [], ...over,
})
const render = async () => (renderToStaticMarkup(await DefaultChargesReportPage())).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("Default charges report page", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loaders.inDuplum.mockResolvedValue([])
  })

  it("says charges are not live, and runs no replays, before go-live", async () => {
    loaders.report.mockResolvedValue(report({ state: "never", startedAt: null }))
    const html = await render()
    expect(html).toContain("Default charges are not live for this tenant")
    expect(html).not.toContain("in duplum")
    expect(loaders.inDuplum).not.toHaveBeenCalled()
  })

  it("after a stop, states it and never claims charges can still accrue", async () => {
    loaders.report.mockResolvedValue(report({ state: "stopped", stoppedAt: new Date("2026-10-01T08:00:00Z") }))
    const html = await render()
    expect(html).toContain("Charges stopped on")
    expect(html).not.toContain("can still accrue")
    expect(loaders.inDuplum).not.toHaveBeenCalled()
  })

  it("while live, shows the in duplum panel and splits charges refunds from all refunds due", async () => {
    loaders.report.mockResolvedValue(report({
      refundsDue: [
        { paymentId: "a", loanId: "l1", loanReference: "LN-1", clientName: "Thandi Mocktest", amount: 8_000, receivedAt: now, dueSince: now, source: "exemption" },
        { paymentId: "b", loanId: "l2", loanReference: "LN-2", clientName: "Sipho Dlamini", amount: 5_000, receivedAt: now, dueSince: now, source: "over-payment" },
      ],
    }))
    loaders.inDuplum.mockResolvedValue([
      { loanId: "l3", loanReference: "LN-3", clientName: "Lerato Nkosi", productName: "Micro", capBase: 200_000, accrued: 200_000 },
    ])
    const html = await render()
    expect(html).toContain("At the in duplum cap")
    expect(html).toContain("Lerato Nkosi")
    // The engine's figure adds the contractual amounts reserved when the default began; the page must not call it accrued.
    expect(html).not.toContain("Accrued against cap")
    expect(html).toContain("contractual interest, fees and credit-life premiums of the instalments due from the day this default began")
    expect(html).toContain("Charges to refund R 80.00")
    expect(html).toContain("R 130.00 refunds due in all")
    expect(html).toContain("Charges exemption")
    expect(html).toContain("Over-payment")
  })
})
