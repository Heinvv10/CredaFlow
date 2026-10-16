import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runReferenceRateFeed } = vi.hoisted(() => ({ runReferenceRateFeed: vi.fn() }))
vi.mock("@/lib/asset-finance/rate-feed-sync", () => ({ runReferenceRateFeed }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { GET } from "./route"

// The route's own contract: the cron secret first, 200 when the run is ok and
// 503 with the reason when it is not. What a run does is proven in
// lib/asset-finance/rate-feed-sync.test.ts and rate-feed.integration.test.ts.

const SECRET = "unit-test-cron-secret"
const request = (secret?: string) =>
  new NextRequest("http://localhost/api/cron/reference-rate-feed", { headers: secret === undefined ? {} : { "x-cron-secret": secret } })

describe("GET /api/cron/reference-rate-feed", () => {
  const saved = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    runReferenceRateFeed.mockReset().mockResolvedValue({ ok: true, perTenant: [] })
  })
  afterEach(() => { process.env.CRON_SECRET = saved })

  it("refuses a wrong or missing secret without fetching anything", async () => {
    expect((await GET(request("not-the-cron-secret-!!"))).status).toBe(401)
    expect((await GET(request())).status).toBe(401)
    expect(runReferenceRateFeed).not.toHaveBeenCalled()
  })

  it("refuses everything while CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET
    expect((await GET(request(SECRET))).status).toBe(500)
    expect(runReferenceRateFeed).not.toHaveBeenCalled()
  })

  it("runs and returns the per-tenant counts", async () => {
    const run = { ok: true, perTenant: [{ tenantId: "t1", recorded: [], skipped: { unchanged: 3 }, failed: 0 }] }
    runReferenceRateFeed.mockResolvedValue(run)
    const response = await GET(request(SECRET))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(run)
  })

  it("answers 503 with the reason when the feed could not be read", async () => {
    const run = { ok: false, reason: "feed_unavailable", feed: { ok: false, reason: "http_status", detail: "the feed answered HTTP 502" } }
    runReferenceRateFeed.mockResolvedValue(run)
    const response = await GET(request(SECRET))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(run)
  })

  it("answers 503 when recording failed for a tenant", async () => {
    runReferenceRateFeed.mockResolvedValue({ ok: false, reason: "tenant_failed", perTenant: [] })
    expect((await GET(request(SECRET))).status).toBe(503)
  })
})
