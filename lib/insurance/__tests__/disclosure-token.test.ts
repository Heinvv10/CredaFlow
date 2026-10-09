// lib/insurance/__tests__/disclosure-token.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { signDraftToken, verifyDraftToken, type DraftPayload } from "../disclosure-token"

const FIXED_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
const fixture: DraftPayload = {
  tenantId: "tenant-1",
  clientId: "client-1",
  advisorId: "advisor-1",
  type: "FUNERAL_COVER",
  sumAssured: 100000,
  premiumAmount: 50000,
  productId: "product-1",
}

beforeEach(() => { vi.stubEnv("NEXTAUTH_SECRET", FIXED_SECRET) })
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("signDraftToken / verifyDraftToken", () => {
  it("round-trips a valid payload", () => {
    const token = signDraftToken(fixture)
    const result = verifyDraftToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.tenantId).toBe("tenant-1")
      expect(result.payload.iat).toBeTypeOf("number")
    }
  })

  it("rejects a tampered token", () => {
    const token = signDraftToken(fixture)
    const [payload, sig] = token.split(".")
    const tampered = `${payload}AAAA.${sig}`
    const result = verifyDraftToken(tampered)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid_signature")
  })

  it("rejects a token with a flipped byte in the payload", () => {
    const token = signDraftToken(fixture)
    const [payloadB64, sigB64] = token.split(".")
    // Replace one char in the payload base64 (around position 5) with a different char
    const flipped = payloadB64.slice(0, 5) + (payloadB64[5] === "A" ? "B" : "A") + payloadB64.slice(6)
    const result = verifyDraftToken(`${flipped}.${sigB64}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid_signature")
  })

  it("rejects a token older than 1 hour", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"))
    const token = signDraftToken(fixture)
    vi.setSystemTime(new Date("2026-01-01T11:00:01Z"))
    const result = verifyDraftToken(token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("expired")
  })

  it("rejects when NEXTAUTH_SECRET differs", () => {
    const token = signDraftToken(fixture)
    vi.stubEnv("NEXTAUTH_SECRET", "different-secret-1234567890abcdef")
    const result = verifyDraftToken(token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid_signature")
  })
})
