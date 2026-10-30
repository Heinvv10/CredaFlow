import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const clients = vi.hoisted(() => [] as Array<{ url: string; query: ReturnType<typeof vi.fn> }>)
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    query = vi.fn(async (..._args: unknown[]) => [{ n: 1, retry_ms: null }])
    constructor(options: { datasourceUrl: string }) {
      clients.push({ url: options.datasourceUrl, query: this.query })
    }
    $queryRaw(...args: unknown[]) {
      return this.query(...args)
    }
  },
}))

import { SharedStoreUnavailableError } from "./rate-limit-errors"
import { checkSharedRateLimit, createPostgresStore, keyHash, limiterDatabaseUrl, LOCK_TIMEOUT_MS, NEW_KEYS_PER_ADDRESS, STATEMENT_TIMEOUT_MS } from "./rate-limit-store"

const OPTS = { limit: 3, windowMs: 60_000 }

describe("createPostgresStore", () => {
  it("reports any database error as the store being unavailable, keeping the cause", async () => {
    const cause = new Error("ECONNREFUSED")
    const check = createPostgresStore({ $queryRaw: vi.fn().mockRejectedValue(cause) })
    const error = await check("ns", "k", OPTS).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SharedStoreUnavailableError)
    expect((error as Error).cause).toBe(cause)
  })

  it.each([
    ["a statement timeout", { code: "P2010", meta: { code: "57014" } }, "timeout"],
    ["a lock timeout", { code: "P2010", meta: { code: "55P03" } }, "timeout"],
    ["no free connection in the pool", { code: "P2024" }, "saturated"],
    ["a refused connection", { code: "P1001" }, "error"],
    ["a failed query", { code: "P2010", meta: { code: "42P01" } }, "error"],
    ["an unknown failure", new Error("boom"), "error"],
  ])("tells %s apart: it is a %s", async (_label, cause, kind) => {
    const check = createPostgresStore({ $queryRaw: vi.fn().mockRejectedValue(cause) })
    const error = await check("ns", "k", OPTS).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SharedStoreUnavailableError)
    expect((error as SharedStoreUnavailableError).kind).toBe(kind)
  })

  it("answers a limit of 0 without a query", async () => {
    const query = vi.fn()
    expect(await createPostgresStore({ $queryRaw: query })("ns", "k", { limit: 0, windowMs: 1000 })).toMatchObject({ allowed: false })
    expect(query).not.toHaveBeenCalled()
  })

  it("maps the row to a result: a count means allowed with the remainder, no count means refused with the wait", async () => {
    const rows = [{ n: 2, retry_ms: null }]
    const check = createPostgresStore({ $queryRaw: vi.fn(async () => rows) as never })
    expect(await check("ns", "k", OPTS)).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 })
    rows[0] = { n: null, retry_ms: 4200 } as never
    expect(await check("ns", "k", OPTS)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 5 })
  })

  describe("a refused call", () => {
    const refused = [{ n: null }]
    const noRow: unknown[] = [] // the follow-up read finds no row: the group is sealed and took no new key
    const created = [{ n: 1 }]
    const bypassOf = (call: unknown[]) => call.slice(1).includes(true)
    const sealedFirst = () => vi.fn().mockResolvedValueOnce(refused).mockResolvedValueOnce(noRow)

    it("reads why it was refused in a statement of its own and, for a key with a row, tells the wait: no budget is touched", async () => {
      const query = vi.fn().mockResolvedValueOnce(refused).mockResolvedValueOnce([{ retry_ms: 4200 }])
      const result = await createPostgresStore({ $queryRaw: query }, { selfHeal: false })("", "login:email:x@y.example", OPTS, "login:email:", "203.0.113.9")
      expect(result).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 5 })
      expect(query).toHaveBeenCalledTimes(2)
    })

    it("does not mistake a concurrent commit for a sealed group: a row found by the follow-up read means no credit is spent", async () => {
      // the upsert refused on the limit; its snapshot may predate the row, but the follow-up read sees it
      const query = vi.fn().mockResolvedValueOnce(refused).mockResolvedValueOnce([{ retry_ms: null }])
      const result = await createPostgresStore({ $queryRaw: query }, { selfHeal: false })("", "login:email:x@y.example", OPTS, "login:email:", "203.0.113.9")
      expect(result).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 1 })
      expect(query).toHaveBeenCalledTimes(2)
    })

    it("refuses a key with no row, telling the caller to come back later, when no address is given", async () => {
      const query = sealedFirst()
      const result = await createPostgresStore({ $queryRaw: query }, { selfHeal: false })("", "login:email:x@y.example", OPTS, "login:email:")
      expect(result).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 300 })
      expect(query).toHaveBeenCalledTimes(2)
    })

    it("creates the key when its address has budget for new keys: budget spent first, then the key made past the seal", async () => {
      const query = sealedFirst().mockResolvedValueOnce(created).mockResolvedValueOnce(created)
      const result = await createPostgresStore({ $queryRaw: query }, { selfHeal: false })("", "login:email:x@y.example", OPTS, "login:email:", "203.0.113.9")
      expect(result).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 })
      // the key's own upsert and why-read, the budget upsert, the key made past the seal
      expect(query).toHaveBeenCalledTimes(4)
      expect(query.mock.calls.map(bypassOf)).toEqual([false, false, false, true])
      expect(query.mock.calls[2]!.slice(1)).toContain("sealed-new:")
      expect(query.mock.calls[2]!.slice(1)).toContain(NEW_KEYS_PER_ADDRESS)
    })

    it("refuses when the address has spent its budget, and makes no key", async () => {
      const query = sealedFirst().mockResolvedValueOnce(refused).mockResolvedValueOnce([{ retry_ms: 5000 }])
      const result = await createPostgresStore({ $queryRaw: query }, { selfHeal: false })("", "login:email:x@y.example", OPTS, "login:email:", "203.0.113.9")
      expect(result).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 300 })
      expect(query).toHaveBeenCalledTimes(4)
      expect(query.mock.calls.some(bypassOf)).toBe(false)
    })

    it("lifts the seal itself when the group is back under the ceiling, and then makes the key", async () => {
      const query = sealedFirst().mockResolvedValueOnce([{ lifted: 1 }]).mockResolvedValueOnce(created)
      const result = await createPostgresStore({ $queryRaw: query }, { sealCeiling: 100 })("", "login:email:x@y.example", OPTS, "login:email:")
      expect(result.allowed).toBe(true)
      expect(query).toHaveBeenCalledTimes(4)
      // the check counts the group's live rows against the ceiling
      expect(query.mock.calls[2]!.slice(1)).toEqual(expect.arrayContaining(["login:email:", 100]))
    })

    it("checks a sealed group at most once a minute per process, and keeps refusing when it is still full", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-30T10:00:00Z") })
      try {
        const query = vi.fn(async (strings: TemplateStringsArray) => {
          const text = strings.join("?")
          if (text.includes("DELETE FROM")) return [{ lifted: 0 }]
          if (text.includes("SELECT (SELECT extract")) return [] // why-read: no row
          return refused
        })
        const check = createPostgresStore({ $queryRaw: query as never }, { sealCeiling: 100 })
        const healChecks = () => query.mock.calls.filter(([strings]) => (strings as TemplateStringsArray).join("?").includes("DELETE FROM")).length
        expect((await check("", "login:email:a@y.example", OPTS, "login:email:")).allowed).toBe(false)
        expect((await check("", "login:email:b@y.example", OPTS, "login:email:")).allowed).toBe(false)
        expect(healChecks()).toBe(1)
        vi.advanceTimersByTime(61_000)
        await check("", "login:email:c@y.example", OPTS, "login:email:")
        expect(healChecks()).toBe(2)
        // another group has its own clock
        await check("", "forgot:acct:a@y.example", OPTS, "forgot:acct:")
        expect(healChecks()).toBe(3)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it("hashes namespace and key apart, so no pair collides with another by concatenation", () => {
    expect(keyHash("ab", "c")).not.toBe(keyHash("a", "bc"))
    expect(keyHash("ns", "k")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("gives the limiter its own small pool unless the URL already says otherwise, and each pool its own size", () => {
    const own = new URL(limiterDatabaseUrl("postgresql://u:p@db:5432/app?schema=public"))
    expect(own.searchParams.get("connection_limit")).toBe("3")
    expect(new URL(limiterDatabaseUrl("postgresql://u:p@db:5432/app", 5)).searchParams.get("connection_limit")).toBe("5")
    // a connection is waited for for 1 s: under the limiter's own 1.5 s timeout
    expect(own.searchParams.get("pool_timeout")).toBe("1")
    expect(own.searchParams.get("schema")).toBe("public")
    const set = new URL(limiterDatabaseUrl("postgresql://u:p@db:5432/app?connection_limit=2&pool_timeout=9"))
    expect([set.searchParams.get("connection_limit"), set.searchParams.get("pool_timeout")]).toEqual(["2", "9"])
    expect(limiterDatabaseUrl("not a url")).toBe("not a url")
    // a lock wait and a statement are cancelled by the server before the limiter's own timeout
    expect(own.searchParams.get("options")).toBe(`-c lock_timeout=${LOCK_TIMEOUT_MS} -c statement_timeout=${STATEMENT_TIMEOUT_MS}`)
    expect(LOCK_TIMEOUT_MS).toBeLessThan(STATEMENT_TIMEOUT_MS)
    expect(STATEMENT_TIMEOUT_MS).toBeLessThan(1500)
    expect(new URL(limiterDatabaseUrl("postgresql://u:p@db/app?options=-c%20search_path%3Dx")).searchParams.get("options")).toBe(`-c search_path=x -c lock_timeout=${LOCK_TIMEOUT_MS} -c statement_timeout=${STATEMENT_TIMEOUT_MS}`)
    expect(new URL(limiterDatabaseUrl("postgresql://u:p@db/app?options=-c%20statement_timeout%3D50%20-c%20lock_timeout%3D10")).searchParams.get("options")).toBe("-c statement_timeout=50 -c lock_timeout=10")
  })
})

describe("checkSharedRateLimit: pools", () => {
  beforeEach(() => {
    clients.length = 0
    delete (globalThis as { rateLimitStores?: unknown }).rateLimitStores
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db:5432/app")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("keeps authentication limits on a pool of their own, apart from the ordinary limits", async () => {
    const opts = { limit: 5, windowMs: 1000 }
    await checkSharedRateLimit("", "login:ip:1.2.3.4", opts, "login:ip:")
    await checkSharedRateLimit("oauth:client", "c1", opts, "oauth:client")
    await checkSharedRateLimit("", "website:contact:1.2.3.4", opts, "")
    await checkSharedRateLimit("lender-api:key", "k1", opts, "lender-api:key")
    expect(clients).toHaveLength(2)
    const sizes = clients.map((c) => new URL(c.url).searchParams.get("connection_limit"))
    expect(sizes).toEqual(["5", "3"])
    // the auth calls went to the first client, the ordinary ones to the second
    expect(clients[0]!.query).toHaveBeenCalledTimes(2)
    expect(clients[1]!.query).toHaveBeenCalledTimes(2)
  })

  it("is unavailable, not a bug, when there is no database to ask", async () => {
    vi.stubEnv("DATABASE_URL", "")
    await expect(checkSharedRateLimit("", "login:ip:1.2.3.4", { limit: 5, windowMs: 1000 }, "login:ip:")).rejects.toBeInstanceOf(SharedStoreUnavailableError)
  })
})
