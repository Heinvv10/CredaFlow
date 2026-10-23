import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The real verifyCronSecret: only the work behind it is stubbed.
const runArrangementCheck = vi.hoisted(() => vi.fn())
vi.mock("@/lib/collections/arrangement-check", () => ({ runArrangementCheck }))

import { GET } from "./route"

const clean = { processed: 3, kept: 1, completed: 1, broken: 1, failed: 0, tenants: 2, failedTenants: 0 }
const req = (secret?: string) =>
  new NextRequest("http://localhost/api/cron/arrangement-check", secret === undefined ? {} : { headers: { "x-cron-secret": secret } })

describe("GET /api/cron/arrangement-check", () => {
  const original = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = "arr-secret"
    runArrangementCheck.mockReset()
    runArrangementCheck.mockResolvedValue(clean)
  })
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = original
  })

  it("answers 401 and settles nothing without the secret, or with a wrong one of the same length", async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req("x".repeat("arr-secret".length)))).status).toBe(401)
    expect(runArrangementCheck).not.toHaveBeenCalled()
  })

  it("answers 200 with the counts when every tenant settled", async () => {
    const res = await GET(req("arr-secret"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, partial: false, broken: 1 })
  })

  it("answers 503 when an update failed: a verdict that was not written is a hold that never lifts", async () => {
    runArrangementCheck.mockResolvedValue({ ...clean, failed: 1 })
    const res = await GET(req("arr-secret"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, failed: 1 })
  })

  it("answers 200 partial when one tenant threw and another settled, and 503 when all threw", async () => {
    runArrangementCheck.mockResolvedValue({ ...clean, failedTenants: 1 })
    const partial = await GET(req("arr-secret"))
    expect(partial.status).toBe(200)
    expect(await partial.json()).toMatchObject({ partial: true })
    runArrangementCheck.mockResolvedValue({ ...clean, failedTenants: 2 })
    expect((await GET(req("arr-secret"))).status).toBe(503)
  })
})
