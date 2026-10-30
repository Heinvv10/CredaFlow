import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const sweep = vi.hoisted(() => vi.fn())
vi.mock("@/lib/decisioning/digital-due", () => ({ sweepDigitalDecisions: sweep }))

import { GET } from "./route"

const request = (secret?: string) => new NextRequest("http://x/api/cron/digital-decisions", { headers: secret ? { "x-cron-secret": secret } : {} })

beforeEach(() => { sweep.mockReset(); process.env.CRON_SECRET = "s3cret" })

describe("GET /api/cron/digital-decisions", () => {
  it("refuses a caller without the cron secret and sweeps nothing", async () => {
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(sweep).not.toHaveBeenCalled()
  })
  it("sweeps and answers 200 when nothing failed", async () => {
    sweep.mockResolvedValue({ swept: 2, gaveUp: 0, failed: 0 })
    const res = await GET(request("s3cret"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, swept: 2 })
  })
  it("answers 503 when a row failed, so the scheduler sees it", async () => {
    sweep.mockResolvedValue({ swept: 1, gaveUp: 0, failed: 1 })
    expect((await GET(request("s3cret"))).status).toBe(503)
  })
})
