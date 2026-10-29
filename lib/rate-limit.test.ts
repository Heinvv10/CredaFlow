import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const shared = vi.hoisted(() => vi.fn())
vi.mock("./rate-limit-store", () => ({ checkSharedRateLimit: shared }))

import { _resetRateLimitStore, checkRateLimit, createRateLimiter } from "./rate-limit"

const OPTS = { limit: 3, windowMs: 60_000 }
const ALLOWED = { allowed: true, remaining: 2, retryAfterSeconds: 0 }

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-29T10:00:00Z") })
  vi.stubEnv("RATE_LIMIT_STORE", "memory")
  shared.mockReset()
  _resetRateLimitStore()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("memory store (RATE_LIMIT_STORE=memory)", () => {
  it("allows up to the limit inside the window, then refuses with the time until the oldest hit leaves", async () => {
    expect((await checkRateLimit("k", OPTS)).remaining).toBe(2)
    vi.advanceTimersByTime(10_000)
    await checkRateLimit("k", OPTS)
    await checkRateLimit("k", OPTS)
    const refused = await checkRateLimit("k", OPTS)
    expect(refused).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 50 })
    expect(shared).not.toHaveBeenCalled()
  })

  it("is a sliding window: a hit stops counting exactly one window after it", async () => {
    await checkRateLimit("k", OPTS)
    vi.advanceTimersByTime(30_000)
    await checkRateLimit("k", OPTS)
    await checkRateLimit("k", OPTS)
    expect((await checkRateLimit("k", OPTS)).allowed).toBe(false)
    vi.advanceTimersByTime(30_001)
    expect((await checkRateLimit("k", OPTS)).allowed).toBe(true)
  })

  it("does not count a refused attempt, so hammering does not extend the lockout", async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit("k", OPTS)
    for (let i = 0; i < 20; i++) expect((await checkRateLimit("k", OPTS)).allowed).toBe(false)
    vi.advanceTimersByTime(60_001)
    expect((await checkRateLimit("k", OPTS)).allowed).toBe(true)
  })

  it("keeps keys apart", async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit("a", OPTS)
    expect((await checkRateLimit("b", OPTS)).allowed).toBe(true)
  })

  it("refuses everything when the limit is 0", async () => {
    expect((await checkRateLimit("k", { limit: 0, windowMs: 1000 })).allowed).toBe(false)
  })
})

describe("createRateLimiter", () => {
  it("has its own store: a flood of one limiter's keys cannot evict another's", async () => {
    const small = createRateLimiter(2, "small")
    const other = createRateLimiter(10, "other")
    for (let i = 0; i < 3; i++) await other("key", OPTS)
    for (let i = 0; i < 50; i++) await small(`flood-${i}`, OPTS)
    expect((await other("key", OPTS)).allowed).toBe(false)
  })

  it("evicts the oldest key beyond its cap (bounded memory)", async () => {
    const limiter = createRateLimiter(2, "capped")
    for (let i = 0; i < 3; i++) await limiter("first", OPTS)
    await limiter("second", OPTS)
    await limiter("third", OPTS)
    expect((await limiter("first", OPTS)).allowed).toBe(true)
  })
})

describe("shared store (RATE_LIMIT_STORE=postgres)", () => {
  beforeEach(() => vi.stubEnv("RATE_LIMIT_STORE", "postgres"))

  it("takes the decision from the shared store, with the namespace of the limiter", async () => {
    shared.mockResolvedValue(ALLOWED)
    const limiter = createRateLimiter(100, "lender-api:key")
    expect(await limiter("abc", OPTS)).toEqual(ALLOWED)
    expect(shared).toHaveBeenCalledWith("lender-api:key", "abc", OPTS)
    await checkRateLimit("login:ip:1.2.3.4", OPTS)
    expect(shared).toHaveBeenLastCalledWith("", "login:ip:1.2.3.4", OPTS)
  })

  it("passes a refusal through unchanged", async () => {
    shared.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 42 })
    expect(await checkRateLimit("k", OPTS)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 42 })
  })

  it("never goes fully open: on a store error it enforces the limit in memory", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    shared.mockRejectedValue(new Error("connection refused"))
    for (let i = 0; i < 3; i++) expect((await checkRateLimit("k", OPTS)).allowed).toBe(true)
    expect((await checkRateLimit("k", OPTS)).allowed).toBe(false)
  })

  it("stops asking a failing store for a while, then tries it again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    shared.mockRejectedValue(new Error("down"))
    await checkRateLimit("a", OPTS)
    await checkRateLimit("b", OPTS)
    await checkRateLimit("c", OPTS)
    expect(shared).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    shared.mockResolvedValue(ALLOWED)
    expect(await checkRateLimit("d", OPTS)).toEqual(ALLOWED)
    expect(shared).toHaveBeenCalledTimes(2)
  })

  it("treats a store that does not answer in time as down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    shared.mockReturnValue(new Promise(() => {}))
    const pending = checkRateLimit("k", OPTS)
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await pending).allowed).toBe(true)
    for (let i = 0; i < 2; i++) await checkRateLimit("k", OPTS)
    expect((await checkRateLimit("k", OPTS)).allowed).toBe(false)
  })

  it("logs the failure once per outage, not once per request", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    shared.mockRejectedValue(new Error("down"))
    for (let i = 0; i < 5; i++) await checkRateLimit(`k${i}`, OPTS)
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe("choosing the store", () => {
  it("is memory without DATABASE_URL, whatever else is set", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "")
    vi.stubEnv("DATABASE_URL", "")
    await checkRateLimit("k", OPTS)
    expect(shared).not.toHaveBeenCalled()
  })

  it("is the shared store by default when a database is configured", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "")
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db/x")
    shared.mockResolvedValue(ALLOWED)
    await checkRateLimit("k", OPTS)
    expect(shared).toHaveBeenCalledTimes(1)
  })

  it("is memory when asked, even with a database", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "memory")
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db/x")
    await checkRateLimit("k", OPTS)
    expect(shared).not.toHaveBeenCalled()
  })

  it("refuses to guess at an unknown value", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "redis")
    await expect(checkRateLimit("k", OPTS)).rejects.toThrow(/RATE_LIMIT_STORE/)
  })
})
