import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn() }))
vi.mock("@/lib/collections/escalation", () => ({ processEscalations: vi.fn() }))

import { verifyCronSecret } from "@/lib/cron-auth"
import { processEscalations } from "@/lib/collections/escalation"
import { GET } from "./route"

const req = () => new NextRequest(new URL("http://localhost/api/cron/escalations"))

describe("GET /api/cron/escalations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyCronSecret).mockReturnValue(null as unknown as NextResponse)
  })

  it("returns 401 when CRON_SECRET is missing/wrong", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(processEscalations).not.toHaveBeenCalled()
  })

  // A rule that keeps throwing (Section 129 notice, DEFAULTED status flip,
  // commission clawback — see lib/collections/escalation.ts) previously had
  // NO counter at all: no `errors` field, no `ok` field, just a 200 every
  // time. That left a loan permanently un-escalated and invisible to the
  // systemd wrapper, which calls this with `curl -fsS` and never parses the
  // JSON body.
  it("reports ok:false and 503 when an escalation rule threw", async () => {
    vi.mocked(processEscalations).mockResolvedValue({
      tenants: 1, failedTenants: 0, processed: 2, errors: 1, details: ["Error LN-1 section129: PDF render failed"],
    })
    const res = await GET(req())
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.errors).toBe(1)
    expect(res.status).toBe(503)
  })

  it("reports ok:true and 200 when nothing was due to escalate (empty sweep)", async () => {
    vi.mocked(processEscalations).mockResolvedValue({ tenants: 1, failedTenants: 0, processed: 0, errors: 0, details: [] })
    const res = await GET(req())
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it("reports ok:true and 200 when every rule ran cleanly", async () => {
    vi.mocked(processEscalations).mockResolvedValue({
      tenants: 1, failedTenants: 0, processed: 3, errors: 0, details: ["LN-1: soft reminder logged"],
    })
    const res = await GET(req())
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, processed: 3, errors: 0 })
    expect(res.status).toBe(200)
  })

  it("is 200 and partial when one tenant failed and another escalated", async () => {
    vi.mocked(processEscalations).mockResolvedValue({
      tenants: 2, failedTenants: 1, processed: 3, errors: 1, details: ["Tenant A (t_a) failed; see the server log"],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, partial: true, errors: 1, failedTenants: 1 })
  })

  it("is 503 when every tenant failed", async () => {
    vi.mocked(processEscalations).mockResolvedValue({ tenants: 1, failedTenants: 1, processed: 0, errors: 1, details: [] })
    expect((await GET(req())).status).toBe(503)
  })
})
