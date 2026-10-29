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
import { checkSharedRateLimit, createPostgresStore, keyHash, limiterDatabaseUrl, LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS } from "./rate-limit-store"

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
    await checkSharedRateLimit("", "login:ip:1.2.3.4", opts, "login:")
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
    await expect(checkSharedRateLimit("", "login:ip:1.2.3.4", { limit: 5, windowMs: 1000 }, "login:")).rejects.toBeInstanceOf(SharedStoreUnavailableError)
  })
})
