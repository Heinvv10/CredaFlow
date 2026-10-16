import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runRecoveryDeadlineSweep } = vi.hoisted(() => ({ runRecoveryDeadlineSweep: vi.fn() }))
vi.mock("@/lib/asset-finance/recovery-freeze-deadline", () => ({ runRecoveryDeadlineSweep }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { GET } from "./route"

// The route's own contract: secret first, SAST today, non-2xx on any failure.
// What a run does is proven against real Postgres in
// lib/asset-finance/recovery-freeze.integration.test.ts and
// lib/asset-finance/recovery-final-notice-reminder.integration.test.ts.

const SECRET = "unit-test-cron-secret"
const request = (secret = SECRET) =>
  new NextRequest("http://localhost/api/cron/asset-finance-recovery-deadlines", { headers: { "x-cron-secret": secret } })
const run = (failed: number) => ({ ok: failed === 0, day: "2027-01-16", handled: 1, alreadyHandled: 0, reminded: 1, alreadyReminded: 0, failed })

describe("GET /api/cron/asset-finance-recovery-deadlines", () => {
  const saved = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    // 16 Jan 2027, 00:30 SAST, still 15 Jan in UTC.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2027-01-15T22:30:00.000Z") })
    runRecoveryDeadlineSweep.mockReset().mockResolvedValue(run(0))
  })
  afterEach(() => {
    process.env.CRON_SECRET = saved
    vi.useRealTimers()
  })

  it("refuses a wrong secret without running anything", async () => {
    const response = await GET(request("not-the-cron-secret-!!"))
    expect(response.status).toBe(401)
    expect(runRecoveryDeadlineSweep).not.toHaveBeenCalled()
  })

  it("runs for today's SAST date and returns the counts", async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(runRecoveryDeadlineSweep).toHaveBeenCalledWith("2027-01-16")
    expect(await response.json()).toEqual(run(0))
  })

  it("answers 503 with the counts when any recovery failed", async () => {
    runRecoveryDeadlineSweep.mockResolvedValue(run(1))
    const response = await GET(request())
    expect(response.status).toBe(503)
    expect((await response.json()).failed).toBe(1)
  })
})
