import { describe, expect, it, vi } from "vitest"
import { SharedStoreUnavailableError } from "./rate-limit-errors"
import { createPostgresStore, keyHash, limiterDatabaseUrl, STATEMENT_TIMEOUT_MS } from "./rate-limit-store"

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
    ["no free connection in the pool", { code: "P2024" }, "timeout"],
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

  it("gives the limiter its own small pool unless the URL already says otherwise", () => {
    const own = new URL(limiterDatabaseUrl("postgresql://u:p@db:5432/app?schema=public"))
    expect(own.searchParams.get("connection_limit")).toBe("5")
    expect(own.searchParams.get("pool_timeout")).toBe("2")
    expect(own.searchParams.get("schema")).toBe("public")
    const set = new URL(limiterDatabaseUrl("postgresql://u:p@db:5432/app?connection_limit=2&pool_timeout=9"))
    expect([set.searchParams.get("connection_limit"), set.searchParams.get("pool_timeout")]).toEqual(["2", "9"])
    expect(limiterDatabaseUrl("not a url")).toBe("not a url")
    // the server cancels a statement (a wait for a locked row too) before the limiter's own timeout
    expect(own.searchParams.get("options")).toBe(`-c statement_timeout=${STATEMENT_TIMEOUT_MS}`)
    expect(STATEMENT_TIMEOUT_MS).toBeLessThan(1500)
    expect(new URL(limiterDatabaseUrl("postgresql://u:p@db/app?options=-c%20search_path%3Dx")).searchParams.get("options")).toBe(`-c search_path=x -c statement_timeout=${STATEMENT_TIMEOUT_MS}`)
    expect(new URL(limiterDatabaseUrl("postgresql://u:p@db/app?options=-c%20statement_timeout%3D50")).searchParams.get("options")).toBe("-c statement_timeout=50")
  })
})
