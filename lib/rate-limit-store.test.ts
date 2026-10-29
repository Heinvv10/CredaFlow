import { describe, expect, it, vi } from "vitest"
import { SharedStoreUnavailableError } from "./rate-limit-errors"
import { createPostgresStore, keyHash } from "./rate-limit-store"

const OPTS = { limit: 3, windowMs: 60_000 }

describe("createPostgresStore", () => {
  it("reports any database error as the store being unavailable, keeping the cause", async () => {
    const cause = new Error("ECONNREFUSED")
    const check = createPostgresStore({ $queryRaw: vi.fn().mockRejectedValue(cause) })
    const error = await check("ns", "k", OPTS).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SharedStoreUnavailableError)
    expect((error as Error).cause).toBe(cause)
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
})
