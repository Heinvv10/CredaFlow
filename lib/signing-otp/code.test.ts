import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { hashSigningOtp, maskEmail, maskPhone, otpRequestReference, signingOtpMatches } from "./code"

beforeEach(() => vi.stubEnv("AUTH_SECRET", "unit-test-secret"))
afterEach(() => vi.unstubAllEnvs())

describe("signing OTP hash", () => {
  it("is keyed: not a plain digest of the code, and changes with the secret", () => {
    const a = hashSigningOtp("ch-1", "123456")
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toContain("123456")
    vi.stubEnv("AUTH_SECRET", "another-secret")
    expect(hashSigningOtp("ch-1", "123456")).not.toBe(a)
  })

  it("is bound to its challenge: the same code hashes differently on another challenge", () => {
    expect(hashSigningOtp("ch-1", "123456")).not.toBe(hashSigningOtp("ch-2", "123456"))
  })

  it("matches only the right code on the right challenge", () => {
    const stored = hashSigningOtp("ch-1", "123456")
    expect(signingOtpMatches("ch-1", "123456", stored)).toBe(true)
    expect(signingOtpMatches("ch-1", " 123 456 ", stored)).toBe(true)
    expect(signingOtpMatches("ch-1", "123457", stored)).toBe(false)
    expect(signingOtpMatches("ch-2", "123456", stored)).toBe(false)
    expect(signingOtpMatches("ch-1", "12345", stored)).toBe(false)
    expect(signingOtpMatches("ch-1", "12345a", stored)).toBe(false)
  })

  it("refuses to hash without an app secret", () => {
    vi.stubEnv("AUTH_SECRET", "")
    vi.stubEnv("NEXTAUTH_SECRET", "")
    expect(() => hashSigningOtp("ch-1", "123456")).toThrow(/AUTH_SECRET/)
  })
})

describe("evidence masking", () => {
  it("keeps enough of an email to recognise, not to use", () => {
    expect(maskEmail("thandi.mokoena@example.com")).toBe("t***a@e***.com")
    expect(maskEmail("ab@example.org")).toBe("a***@e***.org")
  })

  it("keeps the country code and last four digits of a number", () => {
    expect(maskPhone("27821234567")).toBe("+27 *** *** 4567")
    expect(maskPhone("27821234567@s.whatsapp.net")).toBe("+27 *** *** 4567")
  })

  it("request references are random and unguessable", () => {
    const refs = new Set(Array.from({ length: 50 }, () => otpRequestReference()))
    expect(refs.size).toBe(50)
    for (const r of refs) expect(r).toMatch(/^[0-9A-F]{12}$/)
  })
})
