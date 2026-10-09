import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: vi.fn() }))
vi.mock("@/lib/automation/engine", () => ({ runAutomationEngine: vi.fn() }))

import { verifyCronSecret } from "@/lib/cron-auth"
import { getTenantFromRequest } from "@/lib/tenant"
import { runAutomationEngine } from "@/lib/automation/engine"
import { GET } from "./route"

const req = () => new NextRequest(new URL("http://localhost/api/cron/automation-engine"))

describe("GET /api/cron/automation-engine", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyCronSecret).mockReturnValue(null as unknown as NextResponse)
    vi.mocked(getTenantFromRequest).mockResolvedValue({ id: "tenant-1" } as never)
  })

  it("returns 401 when CRON_SECRET is missing/wrong", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(runAutomationEngine).not.toHaveBeenCalled()
  })

  it("400s when no tenant resolves", async () => {
    vi.mocked(getTenantFromRequest).mockResolvedValue(null as never)
    const res = await GET(req())
    expect(res.status).toBe(400)
  })

  // A rule that throws is caught per-rule inside runAutomationEngine so the
  // rest of the batch still runs — but that means a rule failing on EVERY run
  // never surfaces unless the route itself reports it. The systemd wrapper
  // calls this with `curl -fsS`, which only fails the unit on HTTP >= 400 and
  // never parses the JSON body, so a 200 with ok:false would stay invisible.
  it("reports ok:false and 503 when any automation rule threw", async () => {
    vi.mocked(runAutomationEngine).mockResolvedValue({ ran: 3, actions: 5, errors: 1 })
    const res = await GET(req())
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(res.status).toBe(503)
    expect(json).toMatchObject({ ran: 3, actions: 5, errors: 1 })
  })

  it("reports ok:true and 200 when no rules errored, including an empty sweep", async () => {
    vi.mocked(runAutomationEngine).mockResolvedValue({ ran: 0, actions: 0, errors: 0 })
    const res = await GET(req())
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(res.status).toBe(200)
  })
})
