import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runBureauCron } = vi.hoisted(() => ({ runBureauCron: vi.fn() }))
vi.mock("@/lib/bureau-submission/cron", () => ({ runBureauCron }))

import { GET as daily } from "./bureau-daily/route"
import { GET as monthly } from "./bureau-monthly/route"

// The routes' own contract: secret first, non-2xx on any failure. What a run
// DOES is proven against real Postgres in
// lib/bureau-submission/daily.integration.test.ts.

const SECRET = "unit-test-cron-secret"
const request = (query = "", secret = SECRET) =>
  new NextRequest(`http://localhost/api/cron/x${query}`, { headers: { "x-cron-secret": secret } })

describe.each([
  ["bureau-daily", daily, "DAILY", "?date=2026-08-20", "2026-08-20", "2026-08-31"],
  ["bureau-monthly", monthly, "MONTHLY", "?period=2026-07-31", "2026-07-31", "2026-08-31"],
] as const)("GET /api/cron/%s", (_name, route, kind, query, requestedDay, defaultDay) => {
  const saved = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    // 1 Sep 2026, 00:20 SAST: yesterday and the last month end are both 31 Aug.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-31T22:20:00.000Z") })
    runBureauCron.mockReset().mockResolvedValue({ ok: true, kind, mode: "TEST", day: defaultDay, perTenant: [] })
  })
  afterEach(() => {
    process.env.CRON_SECRET = saved
    vi.useRealTimers()
  })

  it("refuses a wrong secret without running anything", async () => {
    const response = await route(request("", "not-the-cron-secret-!!"))
    expect(response.status).toBe(401)
    expect(runBureauCron).not.toHaveBeenCalled()
  })

  it("runs the period that just ended in SAST by default", async () => {
    const response = await route(request())
    expect(response.status).toBe(200)
    expect(runBureauCron).toHaveBeenCalledWith(kind, defaultDay, expect.any(Date))
  })

  it("runs a requested period", async () => {
    await route(request(query))
    expect(runBureauCron).toHaveBeenCalledWith(kind, requestedDay, expect.any(Date))
  })

  it("answers 400 to a malformed period without running anything", async () => {
    const response = await route(request(query.replace(/=.*/, "=31-08-2026")))
    expect(response.status).toBe(400)
    expect(runBureauCron).not.toHaveBeenCalled()
  })

  it("answers 503, not a hardcoded ok, when any tenant failed", async () => {
    runBureauCron.mockResolvedValue({
      ok: false, kind, mode: "TEST", day: defaultDay, perTenant: [{ tenantId: "t1", outcome: "ERROR", error: "boom" }],
    })
    const response = await route(request())
    expect(response.status).toBe(503)
    expect((await response.json()).ok).toBe(false)
  })
})
