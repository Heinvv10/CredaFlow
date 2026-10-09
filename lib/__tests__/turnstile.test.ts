import { describe, it, expect, afterEach, vi } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

function mockFetch(body: object, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  }))
}

// Tests that hit the !secret branch re-import the module fresh each time so
// the module-level `warnedMissingSecret` flag starts at false.
async function freshVerifyTurnstile() {
  const mod = await import("../turnstile")
  return mod.verifyTurnstile
}

describe("verifyTurnstile", () => {
  it("returns ok:true when Cloudflare says success", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret")
    mockFetch({ success: true })
    const { verifyTurnstile } = await import("../turnstile")
    const result = await verifyTurnstile("valid-token", "1.2.3.4")
    expect(result.ok).toBe(true)
  })

  it("returns ok:false when Cloudflare says not success", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret")
    mockFetch({ success: false, "error-codes": ["invalid-input-response"] })
    const { verifyTurnstile } = await import("../turnstile")
    const result = await verifyTurnstile("bad-token", null)
    expect(result.ok).toBe(false)
    expect(result.errorCodes).toContain("invalid-input-response")
  })

  it("returns ok:false when token is missing", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret")
    const { verifyTurnstile } = await import("../turnstile")
    const result = await verifyTurnstile(null, null)
    expect(result.ok).toBe(false)
    expect(result.errorCodes).toContain("missing-token")
  })

  it("fails closed when secret is missing and bypass not set", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "")
    vi.stubEnv("TURNSTILE_DEV_BYPASS", "0")
    vi.stubEnv("NODE_ENV", "development")
    const verifyTurnstile = await freshVerifyTurnstile()
    const result = await verifyTurnstile("some-token", null)
    expect(result.ok).toBe(false)
    expect(result.errorCodes).toContain("missing-secret")
  })

  it("dev bypass works when TURNSTILE_DEV_BYPASS=1 and non-production", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "")
    vi.stubEnv("TURNSTILE_DEV_BYPASS", "1")
    vi.stubEnv("NODE_ENV", "development")
    const verifyTurnstile = await freshVerifyTurnstile()
    const result = await verifyTurnstile("any-token", null)
    expect(result.ok).toBe(true)
  })

  it("dev bypass is refused in production even with TURNSTILE_DEV_BYPASS=1", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "")
    vi.stubEnv("TURNSTILE_DEV_BYPASS", "1")
    vi.stubEnv("NODE_ENV", "production")
    const verifyTurnstile = await freshVerifyTurnstile()
    const result = await verifyTurnstile("any-token", null)
    expect(result.ok).toBe(false)
    expect(result.errorCodes).toContain("missing-secret")
  })

  it("returns ok:false on HTTP error from Cloudflare", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret")
    mockFetch({}, 503)
    const { verifyTurnstile } = await import("../turnstile")
    const result = await verifyTurnstile("token", null)
    expect(result.ok).toBe(false)
    expect(result.errorCodes).toContain("http-503")
  })

  it("returns ok:false on network error", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network failure")))
    const { verifyTurnstile } = await import("../turnstile")
    const result = await verifyTurnstile("token", null)
    expect(result.ok).toBe(false)
    expect(result.errorCodes).toContain("network-error")
  })

  it("returns ok:false on AbortSignal timeout (Cloudflare latency spike)", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret")
    const abortError = new DOMException("signal timed out", "TimeoutError")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError))
    const { verifyTurnstile } = await import("../turnstile")
    const result = await verifyTurnstile("token", null)
    expect(result.ok).toBe(false)
    expect(result.errorCodes).toContain("network-error")
  })

  it("a client-supplied 'dev-bypass' token does NOT bypass verification when both secret and site key are real (production config)", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "real-production-secret")
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "real-production-site-key")
    mockFetch({ success: false, "error-codes": ["invalid-input-response"] })
    const { verifyTurnstile } = await import("../turnstile")
    const result = await verifyTurnstile("dev-bypass", null)
    // Must fall through to the real Cloudflare siteverify call — a bare
    // client-supplied token string must never be able to grant a bypass on
    // its own, in any environment.
    expect(result.ok).toBe(false)
    expect(result.errorCodes).toContain("invalid-input-response")
  })

  it("bypasses based on OUR OWN test-site-key config, independent of the token value", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "real-production-secret")
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA")
    const { verifyTurnstile } = await import("../turnstile")
    // No fetch mock needed — bypass must happen before any network call, and
    // must work regardless of what token (or lack of one) the caller sends.
    const result = await verifyTurnstile(undefined, null)
    expect(result.ok).toBe(true)
  })
})
