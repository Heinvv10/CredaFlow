import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn() }))
vi.mock("@/lib/collections/reminders", () => ({ processPaymentReminders: vi.fn() }))

import { verifyCronSecret } from "@/lib/cron-auth"
import { processPaymentReminders } from "@/lib/collections/reminders"
import { GET } from "./route"

const req = () => new NextRequest(new URL("http://localhost/api/cron/reminders"))

const emptyResult = { sent: 0, simulated: 0, reconciliationRequired: 0, smsChannelOff: 0, errors: 0, details: [] as string[], tenants: 1, failedTenants: 0, warnings: 0 }

describe("GET /api/cron/reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyCronSecret).mockReturnValue(null as unknown as NextResponse)
  })

  it("returns 401 when CRON_SECRET is missing/wrong", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(processPaymentReminders).not.toHaveBeenCalled()
  })

  // `errors` is the curated failure counter inside processPaymentReminders —
  // consent/opt-out skips and reconciliation-required outcomes don't bump it.
  // A hardcoded 200 would hide a dispatch failure (missing template, bad
  // phone, unparseable Contact) from the systemd wrapper, which calls this
  // with `curl -fsS` and never parses the JSON body.
  it("reports ok:false and 503 when the sweep recorded a dispatch error", async () => {
    vi.mocked(processPaymentReminders).mockResolvedValue({
      ...emptyResult, sent: 2, errors: 1, details: ["Error LN-1 sms: no phone on file"],
    })
    const res = await GET(req())
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(res.status).toBe(503)
  })

  // reconciliationRequired is a row the sweep could NOT resolve on its own
  // (an ambiguous provider outcome or a known-dispatch persistence gap) and
  // needs a human to look at the queue — same shape as messaging-retry's
  // manualReconciliation.
  it("reports ok:false and 503 when a reminder needs manual reconciliation", async () => {
    vi.mocked(processPaymentReminders).mockResolvedValue({
      ...emptyResult, sent: 3, reconciliationRequired: 1,
    })
    const res = await GET(req())
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(res.status).toBe(503)
  })

  it("reports ok:true and 200 when nothing was due (empty sweep)", async () => {
    vi.mocked(processPaymentReminders).mockResolvedValue({ ...emptyResult })
    const res = await GET(req())
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  // The SMS channel being off is configuration, not a fault. It must surface
  // in the body so ops can see how many legs were skipped, but it must NOT
  // fail the unit — `curl -fsS` would page someone every night forever.
  it("reports ok:true and 200 when SMS legs were skipped because the channel is off", async () => {
    vi.mocked(processPaymentReminders).mockResolvedValue({
      ...emptyResult, sent: 2, smsChannelOff: 7,
      details: ["Blocked 7 sms leg(s) this run: SMS not enabled (reminder_7d x7)."],
    })
    const res = await GET(req())
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, smsChannelOff: 7 })
    expect(res.status).toBe(200)
  })

  it("reports ok:true and 200 when reminders sent cleanly", async () => {
    vi.mocked(processPaymentReminders).mockResolvedValue({ ...emptyResult, sent: 5, simulated: 1 })
    const res = await GET(req())
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, sent: 5, simulated: 1 })
    expect(res.status).toBe(200)
  })

  // One lender that fails every night (no lender identity, say) is that tenant's
  // failure, named in the body; only all tenants failing makes the job look failed.
  it("is 200 and partial when some tenants failed and the rest ran clean", async () => {
    vi.mocked(processPaymentReminders).mockResolvedValue({
      ...emptyResult, sent: 4, errors: 1, tenants: 3, failedTenants: 1, details: ["Tenant A (t_a) failed; see the server log"],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, partial: true, failedTenants: 1 })
  })

  it("is 503 when every tenant failed", async () => {
    vi.mocked(processPaymentReminders).mockResolvedValue({ ...emptyResult, errors: 2, tenants: 2, failedTenants: 2 })
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, partial: false })
  })

  it("is 503 when a tenant failed AND a send failed elsewhere", async () => {
    vi.mocked(processPaymentReminders).mockResolvedValue({ ...emptyResult, errors: 2, tenants: 3, failedTenants: 1 })
    expect((await GET(req())).status).toBe(503)
  })
})
