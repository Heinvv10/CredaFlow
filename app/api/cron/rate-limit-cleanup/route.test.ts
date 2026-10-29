import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const executeRaw = vi.hoisted(() => vi.fn())
const queryRaw = vi.hoisted(() => vi.fn())
/** What each statement answers, keyed by a word of its SQL, so the tests do not depend on the order of the calls. */
const answers = vi.hoisted(() => ({ purge: 0, cap: 0, hard: [] as unknown[], sealed: [] as unknown[], over: [] as unknown[] }))
vi.mock("@/lib/prisma", () => ({ prisma: { $executeRaw: executeRaw, $queryRaw: queryRaw } }))

import { GET } from "./route"

const request = (secret?: string) => new NextRequest("http://localhost/api/cron/rate-limit-cleanup", { headers: secret ? { "x-cron-secret": secret } : {} })

beforeEach(() => {
  Object.assign(answers, { purge: 0, cap: 0, hard: [], sealed: [], over: [] })
  const sqlOf = (call: unknown) => (call as TemplateStringsArray).join("?")
  executeRaw.mockReset().mockImplementation(async (sql: TemplateStringsArray) => {
    const text = sqlOf(sql)
    if (/expiresAt" < now\(\)/.test(text) && !/ranked|e\.rn/.test(text)) return answers.purge
    if (/e\.rn/.test(text)) return answers.cap
    return 0 // the seal's insert and delete
  })
  queryRaw.mockReset().mockImplementation(async (sql: TemplateStringsArray) => {
    const text = sqlOf(sql)
    if (/WITH ranked/.test(text)) return answers.hard
    if (/RateLimitSealedGroup/.test(text)) return answers.sealed
    return answers.over
  })
  vi.stubEnv("CRON_SECRET", "synthetic-cron-secret")
})

describe("GET /api/cron/rate-limit-cleanup", () => {
  const ok = "synthetic-cron-secret"

  it("refuses a caller without the cron secret and deletes nothing", async () => {
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request("wrong-secret-of-another-length"))).status).toBe(401)
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it("deletes expired rows on the database clock and reports how many", async () => {
    answers.purge = 7
    const response = await GET(request(ok))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, deleted: 7, capped: 0, hardEvicted: [], sealed: [], overCap: [] })
    const purge = executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?")).find((t) => /DELETE FROM "RateLimitHit"/.test(t) && /"expiresAt" < now\(\)/.test(t))
    expect(purge).toBeDefined()
  })

  it("then caps each ordinary group's rows and says so when it had to", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    answers.cap = 1200
    const body = await (await GET(request(ok))).json()
    expect(body).toMatchObject({ ok: true, capped: 1200 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1200"))
  })

  it("raises an alert for each ordinary group that went past the hard ceiling, where even lockouts were evicted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    answers.hard = [{ ns: "website:chat:", rows: 900_000 }]
    const body = await (await GET(request(ok))).json()
    expect(body.hardEvicted).toEqual([{ ns: "website:chat:", rows: 900_000 }])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('limiter group "website:chat:" exceeded its hard ceiling'))
  })

  it("seals an authentication group at its hard ceiling and raises an alert on every run it stays sealed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    answers.sealed = [{ ns: "login:", rows: 1_000_000 }]
    for (let run = 0; run < 2; run++) {
      const body = await (await GET(request(ok))).json()
      expect(body.sealed).toEqual([{ ns: "login:", rows: 1_000_000 }])
    }
    expect(error.mock.calls.filter(([m]) => String(m).includes('authentication limiter group "login:"') && String(m).includes("takes no new keys"))).toHaveLength(2)
  })

  it("reports a group still over the first ceiling after the cap", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    answers.over = [{ ns: "login:", rows: BigInt(250_000) }]
    const body = await (await GET(request(ok))).json()
    expect(body.overCap).toEqual([{ ns: "login:", rows: 250_000 }])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('limiter group "login:" holds 250000 rows'))
  })

  it("answers 503 when the delete fails, so the run is recorded as failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    executeRaw.mockRejectedValue(new Error("relation does not exist"))
    expect((await GET(request(ok))).status).toBe(503)
  })
})
