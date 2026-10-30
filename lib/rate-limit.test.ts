import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const shared = vi.hoisted(() => vi.fn())
vi.mock("./rate-limit-store", () => ({ checkSharedRateLimit: shared }))

import { _resetRateLimitStore, assertRateLimitStoreConfig, checkRateLimit, createRateLimiter } from "./rate-limit"
import { SharedStoreUnavailableError } from "./rate-limit-errors"

const down = (message = "connection refused") => new SharedStoreUnavailableError(message, { cause: new Error(message), kind: "error" })
const full = () => new SharedStoreUnavailableError("no free connection", { kind: "saturated" })
const slow = (message = "lock wait") => new SharedStoreUnavailableError(message, { cause: new Error(message), kind: "timeout" })

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
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {})

  it("takes the decision from the shared store, with the namespace and the group of the limiter", async () => {
    shared.mockResolvedValue(ALLOWED)
    const limiter = createRateLimiter(100, "lender-api:key")
    expect(await limiter("abc", OPTS)).toEqual(ALLOWED)
    expect(shared).toHaveBeenCalledWith("lender-api:key", "abc", OPTS, "lender-api:key", undefined)
    await checkRateLimit("login:ip:1.2.3.4", OPTS)
    expect(shared).toHaveBeenLastCalledWith("", "login:ip:1.2.3.4", OPTS, "login:ip:", undefined)
    await checkRateLimit("login:email:a@b.example", OPTS, { newKeyAddress: "1.2.3.4" })
    expect(shared).toHaveBeenLastCalledWith("", "login:email:a@b.example", OPTS, "login:email:", "1.2.3.4")
    await checkRateLimit("website:contact:1.2.3.4", OPTS)
    expect(shared).toHaveBeenLastCalledWith("", "website:contact:1.2.3.4", OPTS, "website:", undefined)
  })

  it("passes a refusal through unchanged", async () => {
    shared.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 42 })
    expect(await checkRateLimit("k", OPTS)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 42 })
  })

  it("keeps a site-wide single-key counter per pod: it never reaches the store", async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit("website:chat:start:all", OPTS)
    expect((await checkRateLimit("website:chat:start:all", OPTS)).allowed).toBe(false)
    expect(shared).not.toHaveBeenCalled()
  })

  it("keeps the keys a caller chooses and the address keys in groups of their own", async () => {
    shared.mockResolvedValue(ALLOWED)
    const groups = async (key: string) => {
      await checkRateLimit(key, OPTS)
      return shared.mock.lastCall![3]
    }
    expect(await groups("login:ip:1.2.3.4")).toBe("login:ip:")
    expect(await groups("login:email:a@b.example")).toBe("login:email:")
    expect(await groups("login:combined:a@b.example:1.2.3.4")).toBe("login:combined:")
    expect(await groups("forgot:ip:1.2.3.4")).toBe("forgot:ip:")
    expect(await groups("forgot:acct:a@b.example")).toBe("forgot:acct:")
    expect(await groups("reset-otp:1.2.3.4")).toBe("reset-otp:")
    expect(await groups("reset-otp:acct:a@b.example")).toBe("reset-otp:acct:")
    expect(await groups("register:ip:1.2.3.4")).toBe("register:ip:")
    expect(await groups("register:identity:a@b.example")).toBe("register:identity:")
    expect(await groups("sealed-new:login:email::1.2.3.4")).toBe("sealed-new:")
  })

  it("keeps the ordinary limits a caller can flood with made-up keys in groups of their own, apart from the counters that matter", async () => {
    shared.mockResolvedValue(ALLOWED)
    const groups = async (key: string) => {
      await checkRateLimit(key, OPTS)
      return shared.mock.lastCall![3]
    }
    // keys the caller chooses: a group each
    expect(await groups(`selfie-link:capture:tok:${"a".repeat(32)}`)).toBe("selfie-link:capture:tok:")
    expect(await groups("website:chat:start:phone:27712345678:1.2.3.4")).toBe("website:chat:start:phone:")
    // everything else by its first segment, which the code chooses
    expect(await groups("selfie-link:capture:ip:1.2.3.4")).toBe("selfie-link:")
    expect(await groups("website:contact:1.2.3.4")).toBe("website:")
    expect(await groups("portal:af-sign:t1:c1")).toBe("portal:")
    expect(await groups("statement-ai-ask:user:u1")).toBe("statement-ai-ask:")
    expect(await groups("dealer-capture:t1:d1")).toBe("dealer-capture:")
    // the paid-bureau counters are an authentication-grade group
    expect(await groups("portal:apply:c1")).toBe("portal:apply:")
    expect(await groups("portal:apply:req:c1")).toBe("portal:apply:")
  })

  describe("one store call in flight per key", () => {
    const tracked = () => {
      let running = 0
      let peak = 0
      const perKey = new Map<string, number>()
      shared.mockImplementation(async (_ns: string, key: string) => {
        running++
        peak = Math.max(peak, running)
        perKey.set(key, (perKey.get(key) ?? 0) + 1)
        await new Promise((resolve) => setTimeout(resolve, 20))
        running--
        return ALLOWED
      })
      return { peak: () => peak, perKey }
    }

    it("runs concurrent callers of one key one after the other, each making its own call, so every hit is counted", async () => {
      const t = tracked()
      const calls = Array.from({ length: 10 }, () => checkRateLimit("login:email:a@b.example", OPTS))
      await vi.advanceTimersByTimeAsync(500)
      expect((await Promise.all(calls)).every((r) => r.allowed)).toBe(true)
      expect(shared).toHaveBeenCalledTimes(10)
      expect(t.peak()).toBe(1)
    })

    it("lets different keys run side by side", async () => {
      const t = tracked()
      const calls = ["a", "b", "c", "d"].map((k) => checkRateLimit(`login:email:${k}@b.example`, OPTS))
      await vi.advanceTimersByTimeAsync(100)
      await Promise.all(calls)
      expect(t.peak()).toBe(4)
    })

    it("does not run the turn of a caller that gave up waiting: a stalled key holds one call, not the queue behind it", async () => {
      quiet()
      shared.mockReturnValue(new Promise(() => {}))
      const calls = Array.from({ length: 6 }, () => checkRateLimit("login:email:stuck@b.example", OPTS))
      await vi.advanceTimersByTimeAsync(2_000)
      const results = await Promise.all(calls)
      expect(results.map((r) => r.allowed)).toEqual([false, false, false, false, false, false])
      // only the first reached the store; the others timed out waiting and never ran
      expect(shared).toHaveBeenCalledTimes(1)
    })

    it("never runs the turn of a caller that gave up, even when the call ahead of it finishes late", async () => {
      quiet()
      shared.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(ALLOWED), 3_000))).mockResolvedValue(ALLOWED)
      const calls = Array.from({ length: 4 }, () => checkRateLimit("login:email:slow@b.example", OPTS))
      await vi.advanceTimersByTimeAsync(5_000)
      const results = await Promise.all(calls)
      // the first call gave up at 1.5 s (its answer came at 3 s), the three behind it gave up waiting: none of them ran
      expect(results.every((r) => r.allowed === false)).toBe(true)
      expect(shared).toHaveBeenCalledTimes(1)
    })

    it("forgets a key's lane once it is idle", async () => {
      shared.mockResolvedValue(ALLOWED)
      await checkRateLimit("login:email:a@b.example", OPTS)
      await checkRateLimit("login:email:a@b.example", OPTS)
      expect(shared).toHaveBeenCalledTimes(2)
    })
  })

  describe("when the store is unavailable", () => {
    it.each([
      ["login:email:a@b.example"], ["totp-current-code:u1"], ["sso:code:u1"], ["sso:start:1.2.3.4"], ["forgot:ip:1.2.3.4"],
      ["reset-otp:1.2.3.4"], ["register:identity:a@b.example"], ["portal:apply:c1"], ["portal:apply:req:c1"], ["portal-password-ip:1.2.3.4"], ["signing-otp:verify:ip:1.2.3.4"],
    ])("refuses the authentication attempt %s, and does not fall back to a fresh in-memory budget", async (key) => {
      quiet()
      shared.mockRejectedValue(down())
      for (let i = 0; i < 6; i++) expect(await checkRateLimit(key, OPTS)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 30 })
    })

    it.each([["oauth:client"], ["oauth:failed:address"], ["lender-api:failed-auth:address"]])("refuses on the %s limiter", async (namespace) => {
      quiet()
      shared.mockRejectedValue(down())
      expect((await createRateLimiter(10, namespace)("k", OPTS)).allowed).toBe(false)
    })

    it("falls back to the in-memory limiter, which still enforces the limit, for every other limit", async () => {
      quiet()
      shared.mockRejectedValue(down())
      for (let i = 0; i < 3; i++) expect((await checkRateLimit("website:contact:1.2.3.4", OPTS)).allowed).toBe(true)
      expect((await checkRateLimit("website:contact:1.2.3.4", OPTS)).allowed).toBe(false)
    })

    it("answers a timed-out call alone: an authentication call is refused, and the store is asked again for the next key", async () => {
      quiet()
      shared.mockRejectedValue(slow())
      for (let i = 0; i < 8; i++) expect((await checkRateLimit(`login:email:${i}@x.example`, OPTS)).allowed).toBe(false)
      // eight timeouts opened nothing: the next key reaches the store and is answered by it
      shared.mockResolvedValue(ALLOWED)
      expect(await checkRateLimit("login:email:fresh@x.example", OPTS)).toEqual(ALLOWED)
      expect(shared).toHaveBeenCalledTimes(9)
    })

    it("refuses an authentication call whose pool is full, never deciding it in memory, and opens nothing", async () => {
      quiet()
      shared.mockRejectedValue(full())
      for (let i = 0; i < 12; i++) expect((await checkRateLimit("login:ip:1.2.3.4", { limit: 10, windowMs: 60_000 })).allowed).toBe(false)
      // nothing was opened: the next key still reaches the store
      shared.mockResolvedValue(ALLOWED)
      expect(await checkRateLimit("login:ip:5.6.7.8", OPTS)).toEqual(ALLOWED)
      expect(shared).toHaveBeenCalledTimes(13)
    })

    it("decides a call of any other limit in memory when its pool is full", async () => {
      quiet()
      shared.mockRejectedValue(full())
      for (let i = 0; i < 3; i++) expect((await checkRateLimit("website:contact:k", OPTS)).allowed).toBe(true)
      expect((await checkRateLimit("website:contact:k", OPTS)).allowed).toBe(false)
    })

    it.each([["a timeout", slow], ["a database error", down], ["a full pool", full]])("never decides an authentication call in memory on %s", async (_label, make) => {
      quiet()
      shared.mockRejectedValue(make())
      for (const key of ["login:email:a@b.example", "totp-current-code:u1", "sso:code:u1", "forgot:ip:1.2.3.4", "reset-otp:1.2.3.4", "register:identity:a@b.example", "portal-password-ip:1.2.3.4", "signing-otp:verify:ip:1.2.3.4", "portal:apply:req:c1", "portal:apply:c1"]) {
        expect((await createRateLimiter(10, "oauth:client")(key, OPTS)).allowed).toBe(false)
        expect((await checkRateLimit(key, OPTS)).allowed).toBe(false)
      }
    })

    it("serves a timed-out call of any other limit from memory, again without opening anything", async () => {
      quiet()
      shared.mockRejectedValue(slow())
      for (let i = 0; i < 3; i++) expect((await checkRateLimit("website:contact:k", OPTS)).allowed).toBe(true)
      expect((await checkRateLimit("website:contact:k", OPTS)).allowed).toBe(false)
      expect(shared).toHaveBeenCalledTimes(4)
    })

    it("does not count timeouts towards an outage, even between errors", async () => {
      quiet()
      shared.mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockRejectedValueOnce(slow()).mockRejectedValue(down())
      for (let i = 0; i < 4; i++) await checkRateLimit(`website:contact:${i}`, OPTS)
      // error, error, timeout, error: the timeout neither counts nor resets, so this is the third error and the breaker opens
      expect(shared).toHaveBeenCalledTimes(4)
      await checkRateLimit("website:contact:after", OPTS)
      expect(shared).toHaveBeenCalledTimes(4)
    })

    it("treats a store that does not answer within the limiter's own timeout as a timed-out call: refused, nothing opened", async () => {
      quiet()
      shared.mockReturnValue(new Promise(() => {}))
      const pending = checkRateLimit("login:ip:1.2.3.4", OPTS)
      await vi.advanceTimersByTimeAsync(2_000)
      expect((await pending).allowed).toBe(false)
    })

    it("stops asking the store only after 3 failures in a row, for 30 s, then asks again", async () => {
      quiet()
      shared.mockRejectedValue(down("down"))
      await checkRateLimit("website:contact:a", OPTS)
      await checkRateLimit("website:contact:b", OPTS)
      expect(shared).toHaveBeenCalledTimes(2)
      await checkRateLimit("website:contact:c", OPTS)
      await checkRateLimit("website:contact:d", OPTS)
      await checkRateLimit("website:contact:e", OPTS)
      expect(shared).toHaveBeenCalledTimes(3)
      vi.advanceTimersByTime(60_000)
      shared.mockResolvedValue(ALLOWED)
      expect(await checkRateLimit("website:contact:f", OPTS)).toEqual(ALLOWED)
      expect(shared).toHaveBeenCalledTimes(4)
    })

    it("counts consecutive failures: an answer in between starts the count again", async () => {
      quiet()
      shared.mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockResolvedValueOnce(ALLOWED).mockRejectedValue(down())
      for (let i = 0; i < 5; i++) await checkRateLimit(`website:contact:${i}`, OPTS)
      // fail, fail, ok, fail, fail: never three in a row, so every call reached the store
      expect(shared).toHaveBeenCalledTimes(5)
    })

    it("keeps the breaker per group: one group's outage leaves the others on the shared store", async () => {
      quiet()
      const a = createRateLimiter(10, "ns-a")
      const b = createRateLimiter(10, "ns-b")
      shared.mockImplementation(async (namespace: string) => {
        if (namespace === "ns-a") throw down()
        return ALLOWED
      })
      for (let i = 0; i < 5; i++) await a("k", OPTS)
      expect(shared.mock.calls.filter(([ns]) => ns === "ns-a")).toHaveLength(3)
      expect(await b("k", OPTS)).toEqual(ALLOWED)
      expect(await b("k", OPTS)).toEqual(ALLOWED)
      expect(shared.mock.calls.filter(([ns]) => ns === "ns-b")).toHaveLength(2)
      // and an authentication group's outage does not move the unrelated keys of the default namespace
      shared.mockImplementation(async (_ns: string, key: string) => {
        if (key.startsWith("login:")) throw down()
        return ALLOWED
      })
      for (let i = 0; i < 4; i++) await checkRateLimit(`login:ip:${i}`, OPTS)
      expect(await checkRateLimit("website:contact:z", OPTS)).toEqual(ALLOWED)
    })

    it("opens an authentication group's breaker too: it refuses at once instead of waiting out the timeout each time", async () => {
      quiet()
      shared.mockRejectedValue(down())
      for (let i = 0; i < 6; i++) await checkRateLimit("login:ip:1.2.3.4", OPTS)
      expect(shared).toHaveBeenCalledTimes(3)
    })

    it("rethrows an error that is not the store being unavailable, and does not count it as an outage", async () => {
      shared.mockRejectedValue(new TypeError("limiter called wrongly"))
      for (let i = 0; i < 4; i++) await expect(checkRateLimit("login:ip:1.2.3.4", OPTS)).rejects.toThrow(TypeError)
      expect(shared).toHaveBeenCalledTimes(4)
    })

    it("logs the first failure of an outage and the opening of the breaker, not one line per request", async () => {
      const error = quiet()
      shared.mockRejectedValue(down("down"))
      for (let i = 0; i < 8; i++) await checkRateLimit(`website:contact:${i}`, OPTS)
      expect(error).toHaveBeenCalledTimes(2)
    })
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

  it("refuses to guess at an unknown value, at boot and per call", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "redis")
    expect(() => assertRateLimitStoreConfig()).toThrow(/RATE_LIMIT_STORE/)
    await expect(checkRateLimit("k", OPTS)).rejects.toThrow(/RATE_LIMIT_STORE/)
  })

  it("accepts every value the boot check lets through", () => {
    for (const value of ["", "memory", "postgres", " Postgres "]) {
      vi.stubEnv("RATE_LIMIT_STORE", value)
      expect(() => assertRateLimitStoreConfig()).not.toThrow()
    }
  })
})
