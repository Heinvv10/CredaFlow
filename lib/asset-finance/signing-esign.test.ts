import { afterEach, describe, expect, it, vi } from "vitest"
import { requestIp } from "./signing-esign"

// The e-sign evidence IP follows the trusted-proxy rule (callerIp in
// lib/rate-limit.ts): only the hop TRUSTED_PROXY proxies appended is read, so
// entries a client prepends to X-Forwarded-For never become the signer's IP.
const request = (headers: Record<string, string>) => new Request("http://localhost/sign", { method: "POST", headers })
const FORGED = { "x-forwarded-for": "192.0.2.66, 198.51.100.1, 203.0.113.9" }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("requestIp: the signer IP recorded as e-sign evidence", () => {
  it("behind one trusted proxy, takes the rightmost hop, not the client-forged leftmost", () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    expect(requestIp(request(FORGED))).toBe("203.0.113.9")
  })

  it("behind two trusted proxies, takes the hop the outer proxy saw", () => {
    vi.stubEnv("TRUSTED_PROXY", "2")
    expect(requestIp(request(FORGED))).toBe("198.51.100.1")
  })

  it("with no trusted proxy, records no IP: neither X-Forwarded-For nor X-Real-IP is believed", () => {
    vi.stubEnv("TRUSTED_PROXY", "")
    expect(requestIp(request({ ...FORGED, "x-real-ip": "192.0.2.77" }))).toBeNull()
  })

  it("records no IP when a trusted proxy supplied neither header", () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    expect(requestIp(request({}))).toBeNull()
  })
})
