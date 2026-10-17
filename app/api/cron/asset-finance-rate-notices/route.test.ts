import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"
const { scan, send, findMany } = vi.hoisted(() => ({
  scan: vi.fn(async () => ({ escalated: 1 })),
  send: vi.fn(async () => ({ completed: 0, pending: 1 })),
  findMany: vi.fn(async () => [{ tenantId: "stalled-tenant" }]),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { assetFinanceRateNotice: { findMany } } }))
vi.mock("@/lib/asset-finance/rate-notice-deadline", () => ({ scanRateNoticeDeadlines: scan }))
vi.mock("@/lib/asset-finance/reprice-notice-dispatch", () => ({ dispatchRepriceNotices: send }))
import { GET } from "./route"
const saved = process.env.CRON_SECRET
afterEach(() => {
  process.env.CRON_SECRET = saved
  vi.clearAllMocks()
})
describe("independent rate notice worker", () => {
  it("authenticates before querying obligations", async () => {
    process.env.CRON_SECRET = "synthetic-secret"
    expect((await GET(new NextRequest("http://localhost/api/cron/asset-finance-rate-notices"))).status).toBe(401)
    expect(scan).not.toHaveBeenCalled()
  })
  it("scans and dispatches durable pending tenants without requiring successful repricing or an enabled feature", async () => {
    process.env.CRON_SECRET = "synthetic-secret"
    const response = await GET(
      new NextRequest("http://localhost/api/cron/asset-finance-rate-notices", {
        headers: { "x-cron-secret": "synthetic-secret" },
      })
    )
    expect(response.status).toBe(503)
    expect(scan).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith(expect.anything(), "stalled-tenant")
    expect(findMany).toHaveBeenCalledWith({
      where: { completedAt: null },
      distinct: ["tenantId"],
      select: { tenantId: true },
    })
  })
})
