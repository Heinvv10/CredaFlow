import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const executeRaw = vi.hoisted(() => vi.fn())
vi.mock("@/lib/prisma", () => ({ prisma: { $executeRaw: executeRaw } }))

import { GET } from "./route"

const request = (secret?: string) => new NextRequest("http://localhost/api/cron/rate-limit-cleanup", { headers: secret ? { "x-cron-secret": secret } : {} })

beforeEach(() => {
  executeRaw.mockReset()
  vi.stubEnv("CRON_SECRET", "cron-secret-for-tests-0123456789")
})

describe("GET /api/cron/rate-limit-cleanup", () => {
  it("refuses a caller without the cron secret and deletes nothing", async () => {
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request("wrong-secret-of-another-length"))).status).toBe(401)
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it("deletes expired rows on the database clock and reports how many", async () => {
    executeRaw.mockResolvedValueOnce(7).mockResolvedValueOnce(0)
    const response = await GET(request("cron-secret-for-tests-0123456789"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, deleted: 7, capped: 0 })
    const sql = (executeRaw.mock.calls[0]![0] as TemplateStringsArray).join("?")
    expect(sql).toMatch(/DELETE FROM "RateLimitHit"/)
    expect(sql).toMatch(/"expiresAt" < now\(\)/)
  })

  it("then caps each group's rows and says so when it had to", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(1200)
    const body = await (await GET(request("cron-secret-for-tests-0123456789"))).json()
    expect(body).toMatchObject({ ok: true, deleted: 0, capped: 1200 })
    expect((executeRaw.mock.calls[1]![0] as TemplateStringsArray).join("?")).toMatch(/PARTITION BY "ns"/)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("1200"))
  })

  it("answers 503 when the delete fails, so the run is recorded as failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    executeRaw.mockRejectedValue(new Error("relation does not exist"))
    expect((await GET(request("cron-secret-for-tests-0123456789"))).status).toBe(503)
  })
})
