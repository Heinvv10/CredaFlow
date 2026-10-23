import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runTelematicsPoll } = vi.hoisted(() => ({ runTelematicsPoll: vi.fn() }))
vi.mock("@/lib/telematics/poll", () => ({ runTelematicsPoll }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { GET } from "./route"

// The route's own contract: secret first, non-2xx on any failure. What a run
// does is proven against real Postgres in lib/telematics/*.integration.test.ts.
const SECRET = "unit-test-cron-secret"
const request = (secret?: string) =>
  new NextRequest("http://localhost/api/cron/asset-finance-telematics-poll", { headers: secret === undefined ? {} : { "x-cron-secret": secret } })
const run = (failed: number) => ({ ok: failed === 0, tenants: 1, devices: 2, stored: 9, duplicates: 0, rejected: 0, unknownDevices: 0, failed })

describe("GET /api/cron/asset-finance-telematics-poll", () => {
  const saved = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    runTelematicsPoll.mockReset().mockResolvedValue(run(0))
  })
  afterEach(() => {
    process.env.CRON_SECRET = saved
  })

  it("refuses a missing or wrong secret without polling", async () => {
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request("not-the-cron-secret-!!"))).status).toBe(401)
    expect(runTelematicsPoll).not.toHaveBeenCalled()
  })

  it("polls and returns the counts", async () => {
    const response = await GET(request(SECRET))
    expect(response.status).toBe(200)
    expect(runTelematicsPoll).toHaveBeenCalledWith(expect.any(Date))
    expect(await response.json()).toEqual(run(0))
  })

  it("answers 503 with the counts when anything failed", async () => {
    runTelematicsPoll.mockResolvedValue(run(1))
    const response = await GET(request(SECRET))
    expect(response.status).toBe(503)
    expect((await response.json()).failed).toBe(1)
  })
})
