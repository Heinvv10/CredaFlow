import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The real verifyCronSecret, unlike dpd-clawback.test.ts: only the work behind it is stubbed.
const runDpdUpdate = vi.hoisted(() => vi.fn(async () => ({ processed: 0, updated: 0, skipped: 0, perTenant: [], failedTenants: 0 })))
vi.mock("@/lib/loan/dpd-update", () => ({ runDpdUpdate }))

import { GET } from "./route"

const req = (secret?: string) =>
  new NextRequest("http://localhost/api/cron/dpd-update", secret === undefined ? {} : { headers: { "x-cron-secret": secret } })

describe("GET /api/cron/dpd-update authentication", () => {
  const original = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = "dpd-test-secret"
    runDpdUpdate.mockClear()
  })
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = original
  })

  it("answers 401 and runs nothing without the secret", async () => {
    expect((await GET(req())).status).toBe(401)
    expect(runDpdUpdate).not.toHaveBeenCalled()
  })

  it("answers 401 and runs nothing with a wrong secret of the same length", async () => {
    expect((await GET(req("x".repeat("dpd-test-secret".length)))).status).toBe(401)
    expect(runDpdUpdate).not.toHaveBeenCalled()
  })

  it("runs with the right secret", async () => {
    const res = await GET(req("dpd-test-secret"))
    expect(res.status).toBe(200)
    expect(runDpdUpdate).toHaveBeenCalledTimes(1)
  })
})
