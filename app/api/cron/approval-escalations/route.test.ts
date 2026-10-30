import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const escalate = vi.hoisted(() => vi.fn())
vi.mock("@/lib/approval/escalation", () => ({ escalateOverdueApprovals: escalate }))

import { GET } from "./route"

const request = (secret?: string) => new NextRequest("http://x/api/cron/approval-escalations", { headers: secret ? { "x-cron-secret": secret } : {} })

beforeEach(() => { escalate.mockReset(); process.env.CRON_SECRET = "s3cret" })

describe("GET /api/cron/approval-escalations", () => {
  it("refuses a caller without the cron secret and escalates nothing", async () => {
    expect((await GET(request())).status).toBe(401)
    expect(escalate).not.toHaveBeenCalled()
  })
  it("escalates and answers 200 when nothing failed", async () => {
    escalate.mockResolvedValue({ escalated: 2, reminded: 1, failed: 0 })
    const res = await GET(request("s3cret"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, escalated: 2, reminded: 1 })
  })
  it("answers 503 when a case failed, so the scheduler sees it", async () => {
    escalate.mockResolvedValue({ escalated: 0, reminded: 0, failed: 1 })
    expect((await GET(request("s3cret"))).status).toBe(503)
  })
})
