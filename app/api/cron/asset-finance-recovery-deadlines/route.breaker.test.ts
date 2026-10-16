import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runRecoveryDeadlineSweep } = vi.hoisted(() => ({ runRecoveryDeadlineSweep: vi.fn() }))
vi.mock("@/lib/asset-finance/recovery-freeze-deadline", () => ({ runRecoveryDeadlineSweep }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
import { GET } from "./route"

const SECRET = "unit-test-cron-secret"
const req = (headers: Record<string, string>) => new NextRequest("http://localhost/api/cron/asset-finance-recovery-deadlines", { headers })

describe("REPRO F5 breaker", () => {
  const saved = process.env.CRON_SECRET
  beforeEach(() => { process.env.CRON_SECRET = SECRET; runRecoveryDeadlineSweep.mockReset().mockResolvedValue({ ok: true }) })
  afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved })

  it.each([
    ["no header", {}],
    ["empty header", { "x-cron-secret": "" }],
    ["Bearer prefix", { "x-cron-secret": `Bearer ${SECRET}` }],
    ["Authorization Bearer instead", { authorization: `Bearer ${SECRET}` }],
    ["case changed", { "x-cron-secret": SECRET.toUpperCase() }],
    ["same length wrong", { "x-cron-secret": "x".repeat(SECRET.length) }],
  ])("%s => 401, sweep not run", async (_n, headers) => {
    const res = await GET(req(headers))
    expect(res.status).toBe(401)
    expect(runRecoveryDeadlineSweep).not.toHaveBeenCalled()
  })

  it.each([["unset", undefined], ["empty", ""]])("CRON_SECRET %s => 500 even with a matching empty header, sweep not run", async (_n, v) => {
    if (v === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = v
    const res = await GET(req({ "x-cron-secret": "" }))
    expect(res.status).toBe(500)
    expect(runRecoveryDeadlineSweep).not.toHaveBeenCalled()
  })

  it("exact secret => 200", async () => {
    expect((await GET(req({ "x-cron-secret": SECRET }))).status).toBe(200)
  })
})
