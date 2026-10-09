import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { checkRateLimit, callerIp, _resetRateLimitStore } from "../rate-limit"

beforeEach(() => {
  _resetRateLimitStore()
})

describe("checkRateLimit", () => {
  it("allows requests under the limit", () => {
    const opts = { limit: 3, windowMs: 60_000 }
    expect(checkRateLimit("k", opts).allowed).toBe(true)
    expect(checkRateLimit("k", opts).allowed).toBe(true)
    expect(checkRateLimit("k", opts).allowed).toBe(true)
  })

  it("blocks on the limit+1 request", () => {
    const opts = { limit: 2, windowMs: 60_000 }
    checkRateLimit("k", opts)
    checkRateLimit("k", opts)
    const result = checkRateLimit("k", opts)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it("retryAfterSeconds is always at least 1 (Math.max floor)", () => {
    const opts = { limit: 1, windowMs: 1 }
    const t0 = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(t0)
    checkRateLimit("k", opts)
    const result = checkRateLimit("k", opts)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it("counts different keys independently", () => {
    const opts = { limit: 1, windowMs: 60_000 }
    checkRateLimit("a", opts)
    expect(checkRateLimit("b", opts).allowed).toBe(true)
  })

  it("resets after the window expires", () => {
    const opts = { limit: 1, windowMs: 100 }
    const t0 = Date.now()

    // Fill the bucket at t0
    vi.spyOn(Date, "now").mockReturnValue(t0)
    checkRateLimit("k", opts)
    expect(checkRateLimit("k", opts).allowed).toBe(false)

    // Advance past the window — the t0 entry should be GC'd
    vi.spyOn(Date, "now").mockReturnValue(t0 + 200)
    expect(checkRateLimit("k", opts).allowed).toBe(true)
  })

  it("reports remaining correctly", () => {
    const opts = { limit: 5, windowMs: 60_000 }
    const r1 = checkRateLimit("k", opts)
    expect(r1.remaining).toBe(4)
    const r2 = checkRateLimit("k", opts)
    expect(r2.remaining).toBe(3)
  })
})

describe("callerIp", () => {
  function makeReq(headers: Record<string, string>): Request {
    return new Request("http://example.com", { headers })
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns unknown when no proxy headers and TRUSTED_PROXY=0", () => {
    vi.stubEnv("TRUSTED_PROXY", "0")
    expect(callerIp(makeReq({}))).toBe("unknown")
  })

  it("ignores XFF when TRUSTED_PROXY=0", () => {
    vi.stubEnv("TRUSTED_PROXY", "0")
    expect(callerIp(makeReq({ "x-forwarded-for": "1.2.3.4" }))).toBe("unknown")
  })

  it("takes rightmost XFF entry with TRUSTED_PROXY=1", () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    expect(callerIp(makeReq({ "x-forwarded-for": "evil, 1.2.3.4" }))).toBe("1.2.3.4")
  })

  it("takes second-from-right with TRUSTED_PROXY=2", () => {
    vi.stubEnv("TRUSTED_PROXY", "2")
    // client=A, CDN recorded A, LB recorded CDN_ip
    expect(callerIp(makeReq({ "x-forwarded-for": "A, B, C" }))).toBe("B")
  })

  it("falls back to x-real-ip when XFF chain too short", () => {
    vi.stubEnv("TRUSTED_PROXY", "3")
    // only 1 entry but expect 3 to be stripped — fallback
    expect(callerIp(makeReq({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9")
  })

  it("ignores x-real-ip when TRUSTED_PROXY=0 (attacker-controlled)", () => {
    vi.stubEnv("TRUSTED_PROXY", "0")
    expect(callerIp(makeReq({ "x-real-ip": "5.5.5.5" }))).toBe("unknown")
  })

  it("trusts x-real-ip when TRUSTED_PROXY=1 and no XFF", () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    expect(callerIp(makeReq({ "x-real-ip": "5.5.5.5" }))).toBe("5.5.5.5")
  })
})
