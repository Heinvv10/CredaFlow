import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The real verifyCronSecret: only the job behind it is stubbed.
const runDecisionRecordRetention = vi.hoisted(() => vi.fn(async () => ({ tenants: 2, failedTenants: 1, perTenant: [] })))
vi.mock("@/lib/learning-loop/retention/job", () => ({ runDecisionRecordRetention }))

import { GET } from "./route"

const SECRET = "decision-record-retention-test-secret"
const req = (secret?: string) =>
  new NextRequest("http://localhost/api/cron/decision-record-retention", secret === undefined ? {} : { headers: { "x-cron-secret": secret } })

describe("GET /api/cron/decision-record-retention authentication", () => {
  const original = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    runDecisionRecordRetention.mockClear()
  })
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = original
  })

  it("answers 401 and runs nothing without the secret", async () => {
    expect((await GET(req())).status).toBe(401)
    expect(runDecisionRecordRetention).not.toHaveBeenCalled()
  })

  it("answers 401 and runs nothing with a wrong secret of the same length", async () => {
    expect((await GET(req("x".repeat(SECRET.length)))).status).toBe(401)
    expect(runDecisionRecordRetention).not.toHaveBeenCalled()
  })

  it("runs with the right secret; one failed tenant of two is a 200 partial, counted in the header", async () => {
    const res = await GET(req(SECRET))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-cron-failed-tenants")).toBe("1")
    expect(await res.json()).toMatchObject({ ok: true, partial: true })
    expect(runDecisionRecordRetention).toHaveBeenCalledTimes(1)
  })

  it("answers 503 only when every tenant failed", async () => {
    runDecisionRecordRetention.mockResolvedValueOnce({ tenants: 2, failedTenants: 2, perTenant: [] })
    expect((await GET(req(SECRET))).status).toBe(503)
  })
})
