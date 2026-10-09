import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/cron-auth", () => ({
  verifyCronSecret: vi.fn(),
}))

vi.mock("@/lib/messaging/retry", () => ({
  processRetryBatch: vi.fn(),
}))

import { verifyCronSecret } from "@/lib/cron-auth"
import { processRetryBatch } from "@/lib/messaging/retry"
import { GET } from "./route"
import { NextRequest, NextResponse } from "next/server"

describe("GET /api/cron/messaging-retry", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 401 when CRON_SECRET is missing/wrong", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    )
    const req = new NextRequest(new URL("http://localhost/api/cron/messaging-retry"))
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(processRetryBatch).not.toHaveBeenCalled()
  })

  it("invokes processRetryBatch and returns the summary as JSON", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(null as unknown as NextResponse)
    vi.mocked(processRetryBatch).mockResolvedValue({
      scanned: 7, expired: 2, suppressed: 1, dispatched: 3, simulated: 2,
      manualReconciliation: 0, rescheduled: 1, failedPermanent: 1,
    })
    const req = new NextRequest(new URL("http://localhost/api/cron/messaging-retry"))
    const res = await GET(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual(expect.objectContaining({
      ok: true,
      scanned: 7, expired: 2, suppressed: 1, dispatched: 3, simulated: 2,
      manualReconciliation: 0, rescheduled: 1, failedPermanent: 1,
    }))
    expect(processRetryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, now: expect.any(Date) })
    )
  })

  // manualReconciliation rows are the ones the sweep could NOT resolve by
  // itself (ambiguous provider outcome, a dispatch that never got persisted,
  // or a claimed token that couldn't be finalised) and need a human to look
  // at the queue. failedPermanent/rescheduled are understood, expected
  // per-message outcomes and must NOT flip this to a failed run.
  it("reports ok:false and 503 when the sweep leaves rows needing manual reconciliation", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(null as unknown as NextResponse)
    vi.mocked(processRetryBatch).mockResolvedValue({
      scanned: 5, expired: 0, suppressed: 0, dispatched: 2, simulated: 0,
      manualReconciliation: 1, rescheduled: 1, failedPermanent: 1,
    })
    const req = new NextRequest(new URL("http://localhost/api/cron/messaging-retry"))
    const res = await GET(req)
    const json = await res.json()
    expect(json.ok).toBe(false)
    // The systemd wrapper runs `curl -fsS`, which only fails the unit on
    // HTTP >= 400. A 200 here would keep unresolved dispatches invisible.
    expect(res.status).toBe(503)
  })

  it("reports ok:true and 200 for an empty sweep (lock busy or nothing to do)", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(null as unknown as NextResponse)
    vi.mocked(processRetryBatch).mockResolvedValue({
      scanned: 0, expired: 0, suppressed: 0, dispatched: 0, simulated: 0,
      manualReconciliation: 0, rescheduled: 0, failedPermanent: 0,
    })
    const req = new NextRequest(new URL("http://localhost/api/cron/messaging-retry"))
    const res = await GET(req)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(res.status).toBe(200)
  })
})
